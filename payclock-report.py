"""Read-only FaceIN/CSV adapter using Payclock's existing Excel calculations."""
import csv
import importlib
import json
import hashlib
import importlib.util
import io
import sys
from datetime import datetime
from pathlib import Path
from uuid import uuid4

DAILY = ['Day #', 'Name', 'Date', 'Weekday', 'Punch Count', 'Punch In', 'Lunch Out', 'Lunch In', 'Punch Out', 'Hours Worked', 'Regular Hours', 'Overtime Hours', 'Total Payroll Hours', 'Lunch Hours', 'Lunch Payroll Hrs', 'Status', 'Note']
TOTALS = ['Employee ID', 'Name', 'Total Hours', 'Regular Hours', 'Overtime Hours', 'Total Payroll Hours', 'OK Days', 'Review Days', 'Period']
cache_spec = importlib.util.spec_from_file_location('punch_cache', Path(__file__).with_name('payclock-cache.py'))
cache_module = importlib.util.module_from_spec(cache_spec)
cache_spec.loader.exec_module(cache_module)
PunchCache = cache_module.PunchCache
review_spec=importlib.util.spec_from_file_location('punch_review',Path(__file__).with_name('punch-review.py'))
review=importlib.util.module_from_spec(review_spec)
review_spec.loader.exec_module(review)


def save_json(path, value):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=True, allow_nan=False), encoding='utf-8')
    temporary.replace(path)


def export_excel(engine, request):
    from openpyxl import load_workbook
    report, filters = request['report'], request['filters']
    match = lambda r: (filters['team'] == 'all' or r['group'] == filters['team']) and (filters['employee'] == 'all' or r['employeeId'] == filters['employee'])
    daily = [r for r in report['daily'] if match(r)]
    days = [engine.calc_day(r['employeeId'], r['values'][1], r['values'][2],
            [datetime.strptime(r['values'][2]+' '+p, '%Y-%m-%d %H:%M:%S') for p in r['punches']]) for r in daily]
    file = io.BytesIO()
    engine.write_excel(file, days, f"{report['start']} to {report['end']}")
    file.seek(0)
    book = load_workbook(file)
    sheet = filters['sheet']
    title = {'daily':'Daily Hours', 'totals':'Period Totals', 'review':'Needs Review', 'chart':'Payroll Chart'}[sheet]
    ws = book[title]
    for other in list(book.sheetnames):
        if other != title:
            del book[other]
    if sheet == 'chart':
        headers, values = ['Minutes','Hour Decimal'], report['payrollChart']
    elif sheet == 'totals':
        headers, values = report['totalHeaders'], [r['values'] for r in report['totals'] if match(r)]
    else:
        headers = report['dailyHeaders']
        values = [r['values'] for r in daily if (not filters['day'] or r['values'][2] == filters['day']) and (sheet != 'review' or not r['values'][15].startswith('ok') or r.get('audit') and not r['audit'][0].get('restoreOriginal'))]
    column = filters['sortColumn']
    known = [r for r in values if r[column] is not None]
    missing = [r for r in values if r[column] is None]
    # Preserve the browser's exact filtered sort order via record indices, validated by Node.
    if 'orderedValues' in request:
        values = request['orderedValues']
    else:
        values = sorted(known, key=lambda r:r[column], reverse=filters['sortDirection'] == -1)+missing
    ws.delete_rows(1, ws.max_row)
    ws.append(headers)
    for row_index,row in enumerate(values):
        row = list(row)
        if sheet in ('daily','review'):
            row[2] = datetime.strptime(row[2], '%Y-%m-%d')
        ws.append(row)
        for cell in ws[ws.max_row]:
            if isinstance(cell.value, str):
                cell.data_type = 's'  # Treat source text as text, never as an Excel formula.
        if sheet in ('daily','review'):
            engine._format_daily_sheet_row(ws, ws.max_row)
        else:
            for i in ([2] if sheet == 'chart' else [3,4,5,6]):
                ws.cell(ws.max_row, i).number_format = '0.00'
        if sheet in ('daily','review') and row_index<len(request.get('correctedRows',[])) and request['correctedRows'][row_index]:
            from openpyxl.styles import PatternFill
            for cell in ws[ws.max_row]:cell.fill=PatternFill('solid',fgColor='DCEEFF')
    from openpyxl.styles import Font
    for cell in ws[1]:
        cell.font = Font(bold=True)
    engine.autosize(ws)
    ws.auto_filter.ref = ws.dimensions
    ws.freeze_panes = 'A2'
    book.save(request['excelFile'])
    book.close()
    return {'exportedRows':len(values)}


def load_engine(project):
    sys.path.insert(0, str(Path(project).resolve()))
    return importlib.import_module('export_hours')


def make_report(engine, rows, start, end, name_map, office_ids, excluded=()):
    # These are the same entry points and sequence used by run_export.
    rows = [r for r in rows if r['employee_id'] not in set(excluded)]
    engine.apply_roster_names(rows, name_map)
    filtered = [r for r in rows if start <= engine.parse_ts(r['timestamp']).strftime('%Y-%m-%d') <= end]
    days = engine.build_days(filtered)
    numbering = engine.build_work_day_numbers(days)
    daily, buckets = [], {}
    for day in days:
        group = 'Office' if day.employee_id in office_ids else 'Warehouse'
        values = engine._daily_row_values(day, numbering[(day.employee_id, day.work_date)])
        values[2] = day.work_date
        daily.append({'employeeId': day.employee_id, 'group': group, 'values': values,
                      'punches': [p.strftime('%H:%M:%S') for p in day.punches]})
        b = buckets.setdefault(day.employee_id, {'name': day.name, 'group': group, 'hours': 0., 'regular': 0., 'overtime': 0., 'payroll': 0., 'ok': 0, 'review': 0})
        b['name'] = day.name or b['name']
        if day.hours is None:
            b['review'] += 1
            continue
        regular, overtime = engine.split_regular_overtime(day.work_date, day.hours)
        regular = engine.to_payroll_decimal(regular) or 0.
        overtime = engine.to_payroll_decimal(overtime) or 0.
        b['hours'] += day.hours
        b['regular'] += regular
        b['overtime'] += overtime
        b['payroll'] += regular + overtime
        b['ok' if day.status.startswith('ok') else 'review'] += 1
    totals = []
    for employee in sorted(buckets, key=int):
        b = buckets[employee]
        totals.append({'employeeId': employee, 'group': b['group'], 'values': [int(employee), b['name'],
            round(b['hours'], 2), round(b['regular'], 2), round(b['overtime'], 2), round(b['payroll'], 2),
            b['ok'], b['review'], f"{start} to {end} ({b['group']})"]})
    return {'start': start, 'end': end, 'dailyHeaders': DAILY, 'totalHeaders': TOTALS, 'daily': daily, 'totals': totals,
            'payrollChart': list(engine.PAYROLL_MINUTES_TO_DECIMAL.items()), 'punchCount': len(filtered),
            'generatedAt': datetime.now().astimezone().isoformat()}


def run(request):
    if request.get('action') == 'excel':
        return export_excel(load_engine(request['project']), request)
    start, end = request['start'], request['end']
    a, b = datetime.strptime(start, '%Y-%m-%d'), datetime.strptime(end, '%Y-%m-%d')
    if not 0 <= (b-a).days <= (36524 if request.get('source') == 'cache' else 92):
        raise ValueError('Choose an inclusive range of up to 93 days.')
    project = Path(request['project'])
    engine = load_engine(project)
    output = Path(request['output']) if request.get('output') else None
    cache = PunchCache(output/'punches.sqlite3') if output else None
    if cache:
        for file in request.get('files', []):
            path = Path(file['file'])
            stamp=path.stat().st_mtime
            cache.ingest(engine, engine.load_punches(path), file['start'], file['end'], path.name, hashlib.sha256(path.read_bytes()).hexdigest(), stamp, append_only=True, today=datetime.fromtimestamp(stamp).strftime('%Y-%m-%d'))
    if request.get('source') == 'cache':
        rows = cache.rows(start, end)
        source_name = 'Local timestamp cache'
    elif request.get('csv'):
        source = Path(request['csv'])
        rows = engine.load_punches(source)
        source_name = source.name
    else:
        from facein_pull import FaceInClient, parse_return

        class ReadOnlyClock(FaceInClient):
            def send(self, command, timeout=None):
                if not command.startswith('GetRecord('):
                    raise ValueError('Only timestamp reads are allowed.')
                reply = super().send(command, timeout=90)
                parsed = parse_return(reply)
                results = [r['result'].lower() for r in parsed if 'result' in r]
                if not results or any(r != 'success' for r in results):
                    raise RuntimeError('The clock did not confirm a successful timestamp read.')
                return reply

        missing = cache.info(start, end, request.get('today'))['missingDates']
        spans = []
        from datetime import timedelta
        for date in missing:
            if spans and (datetime.strptime(date,'%Y-%m-%d')-datetime.strptime(spans[-1][1],'%Y-%m-%d')).days == 1:
                spans[-1][1] = date
            else:
                spans.append([date,date])
        with ReadOnlyClock(request['host'], timeout=15) as clock:
            for first,last in spans:
                punches = clock.get_records(datetime.strptime(first,'%Y-%m-%d'), datetime.strptime(last,'%Y-%m-%d').replace(hour=23,minute=59,second=59))
                rows = engine.punches_to_rows(punches)
                cache.ingest(engine, rows, first, last, 'clock-read', uuid4().hex, append_only=True, today=request.get('today'))
        rows = cache.rows(start,end)
        source_name = 'Automatic local cache'
    if cache:
        rows = cache.rows(start, end)
    excluded = set(request.get('excludedEmployees', []))
    name_map = {}
    roster_file = project/'employees_cache.json'
    if roster_file.exists():
        roster = json.loads(roster_file.read_text(encoding='utf-8-sig'))
        name_map.update({str(e['employee_id']): e['name'] for e in roster.get('employees', [])})
    name_map.update(engine.load_name_map(project/'employee_name_map.txt'))
    office_ids = engine.load_office_ids(project/'office_employees.txt')
    adjustment_history=review.load_adjustments(output) if output else {}
    rows,original_rows=review.apply_adjustments(rows,adjustment_history,start,end)
    if request.get('selectedDates'):
        chosen = set(request['selectedDates'])
        rows = [r for r in rows if r['timestamp'][:10] in chosen]
    report = make_report(engine, rows, start, end,
                         name_map, office_ids, excluded)
    review.enrich(report,original_rows,cache.rows(cache.info()['start'],cache.info()['end']) if cache and cache.info()['start'] else original_rows,adjustment_history)
    report['adjustmentsRevision']=max((edits[0]['id'] for edits in adjustment_history.values()),default=0)
    report['source'] = {'kind': request.get('source') or ('saved-csv' if request.get('csv') else 'clock'), 'file': source_name}
    if request.get('selectedDates'):
        report['selectedDates'] = request['selectedDates']
    if cache:
        report['cache'] = cache.info(start, end, request.get('today'))
        report['fetchedRanges'] = spans if request.get('source') in ('auto','clock') else []
        info = report['cache']
        if info['start']:
            all_effective,all_original=review.apply_adjustments(cache.rows(info['start'],info['end']),adjustment_history,info['start'],info['end'])
            all_report = make_report(engine, all_effective, info['start'], info['end'],
                name_map, office_ids, excluded)
            report['employees'] = [{'employeeId':r['employeeId'],'group':r['group'],'name':r['values'][1]} for r in all_report['totals']]
            known = {r['employeeId']: r for r in report['employees']}
            for employee, name in name_map.items():
                if employee not in excluded:
                    known.setdefault(employee, {'employeeId':employee, 'name':name, 'group':'Office' if employee in office_ids else 'Warehouse'})
            report['employees'] = sorted(known.values(), key=lambda r:int(r['employeeId']))
            save_json(output/'roster.json', report['employees'])
            save_json(output/'overview.json', {'rows': [{'date':r['values'][2], 'hours':r['values'][9], 'overtime':r['values'][11], 'status':r['values'][15], 'group':r['group']} for r in all_report['daily']],
                'employees':len(report['employees']), 'latestDay':info['end'], 'files':[], 'errors':[], 'state':'connected',
                'detail':'Persistent timestamp cache. Missing days are fetched read-only; existing punches are kept and deduplicated.', 'cache':info})
        if request.get('saveView',True):
            save_json(output/'last-report.json', report)
    return report


if __name__ == '__main__':
    result_path = Path(sys.argv[2]) if len(sys.argv) == 3 else None
    code = 0
    try:
        request = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')) if result_path else json.load(sys.stdin)
        result = run(request)
    except (OSError, TimeoutError):
        result = {'error': 'Could not read the clock or CSV. Check the clock connection and file access, then retry.'}
        code = 1
    except Exception:
        result = {'error': 'The report could not be calculated. Check the dates, CSV format and Payclock Python dependencies.'}
        code = 1
    encoded = json.dumps(result, ensure_ascii=True, allow_nan=False)
    if result_path:
        result_path.write_text(encoded, encoding='utf-8')
    else:
        print(encoded)
    sys.exit(code)
