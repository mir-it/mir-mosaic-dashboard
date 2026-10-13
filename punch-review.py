import sqlite3
import json
from statistics import median
from itertools import combinations
from collections import Counter

ROLES = ['in', 'lunchOut', 'lunchIn', 'out']
LABELS = ['Arrival', 'Lunch out', 'Lunch in', 'Departure']
def minute(t):
    h,m,s=map(int,t.split(':'));return h*60+m+s/60

def load_adjustments(output):
    file=output/'adjustments.sqlite3'
    if not file.exists():return {}
    c=sqlite3.connect('file:'+file.as_posix()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
    try:
        rows=c.execute('SELECT * FROM adjustments ORDER BY id DESC').fetchall()
        result={}
        for row in rows:
            value=dict(row);value['punches']=json.loads(value['punches']);value['original']=json.loads(value.get('original','[]'));result.setdefault((value['employee'],value['day']),[]).append(value)
        return result
    finally:c.close()

def apply_adjustments(rows,history,start,end):
    original=[dict(r) for r in rows];names={r['employee_id']:r['name'] for r in rows}
    changed={k:v[0] for k,v in history.items() if start<=k[1]<=end and not v[0].get('restoreOriginal')}
    rows=[r for r in rows if (r['employee_id'],r['timestamp'][:10]) not in changed]
    for (employee,day),edit in changed.items():
        original_times=set(edit.get('original',[p['time'] for p in edit['punches']]))
        represented={p['time'] for p in edit['punches']}
        rows.extend(r for r in original if r['employee_id']==employee and r['timestamp'][:10]==day and r['timestamp'][11:19] not in original_times|represented)
        rows.extend({'employee_id':employee,'name':names.get(employee,employee),'timestamp':day+' '+p['time'],'source':'local-adjustment','workcode':''} for p in edit['punches'] if p['enabled'])
    return rows,original

def enrich(report,original,all_rows,history):
    grouped={}
    for r in all_rows:grouped.setdefault((r['employee_id'],r['timestamp'][:10]),set()).add(r['timestamp'][11:19])
    patterns={}
    for (employee,day),times in grouped.items():
        times=sorted(times)
        if len(times)==4 and all(minute(times[i+1])-minute(times[i])>5 for i in range(3)):
            patterns.setdefault(employee,[]).append([minute(t) for t in times])
    raw={}
    for r in original:raw.setdefault((r['employee_id'],r['timestamp'][:10]),set()).add(r['timestamp'][11:19])
    counts=Counter()
    for row in report['daily']:
        key=(row['employeeId'],row['values'][2]);times=sorted(raw.get(key,set()));sample=patterns.get(key[0],[])
        target=[median(v[i] for v in sample) for i in range(4)] if len(sample)>=3 else [8*60,12*60,13*60,17*60]
        # Assign an ordered subset to shift roles; extra punches are suggestions only.
        best=None
        n=min(len(times),4)
        if n:
            for selected in combinations(range(min(len(times),12)),n):
                for roles in combinations(range(4),n):
                    score=sum(abs(minute(times[i])-target[j]) for i,j in zip(selected,roles))
                    if best is None or score<best[0]:best=(score,dict(zip(selected,roles)))
        assignments=[{'time':t,'role':ROLES[best[1][i]] if best and i in best[1] else 'extra','enabled':True} for i,t in enumerate(times)]
        flags=[]
        if len(times)%2:flags.append('Odd punch count: missing or extra punch')
        if len(times)>4:flags.append('Extra punches')
        if any(minute(b)-minute(a)<=5 for a,b in zip(times,times[1:])):flags.append('Punches within five minutes: possible duplicate')
        missing=[LABELS[i] for i in range(4) if not best or i not in best[1].values()]
        if len(times)==3:flags.append('Suggested missing: '+', '.join(missing))
        for flag in flags:counts[flag]+=1
        row['originalPunches']=times;row['suggestion']={'punches':assignments,'flags':flags,'basis':f'{len(sample)} complete four-punch days for this employee' if len(sample)>=3 else 'Default shift times; insufficient employee history','missing':missing,'confidence':'Moderate' if len(sample)>=3 else 'Low'}
        row['audit']=history.get(key,[]);row['revision']=row['audit'][0]['id'] if row['audit'] else 0
        if row['audit'] and not row['audit'][0].get('restoreOriginal'):
            edit=row['audit'][0];active=[p for p in edit['punches'] if p['enabled']];role_times={p['role']:p['time'] for p in active}
            for i,role in enumerate(ROLES):row['values'][5+i]=role_times.get(role,'')
            new_times=set(times)-set(edit.get('original',times))-{p['time'] for p in edit['punches']}
            if new_times:row['values'][15]='review-new-clock-punches'
            expected={'in','out'} if len(active)==2 else set(ROLES)
            if len(active) not in (2,4) or set(role_times)!=expected:row['values'][15]='review-local-assignment'
            row['values'][16]=(row['values'][16]+' · ' if row['values'][16] else '')+'Correction by '+edit['actor']+': '+edit['note']
        elif len(times) not in (2,4):
            # Avoid showing departure as a lunch return on ambiguous uncorrected days.
            role_times={p['role']:p['time'] for p in assignments if p['role']!='extra'}
            for i,role in enumerate(ROLES):row['values'][5+i]=role_times.get(role,'')
            row['values'][16]+=' · Suggested assignments; hours remain provisional'
    for total in report['totals']:
        days=[r for r in report['daily'] if r['employeeId']==total['employeeId']]
        total['values'][6]=sum(r['values'][15].startswith('ok') for r in days)
        total['values'][7]=sum(not r['values'][15].startswith('ok') for r in days)
    report['reviewPatterns']=[{'pattern':k,'days':v} for k,v in counts.most_common()]
