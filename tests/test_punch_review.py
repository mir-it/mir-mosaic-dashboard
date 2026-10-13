import importlib.util
import unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('review',Path(__file__).parents[1]/'punch-review.py');review=importlib.util.module_from_spec(s);s.loader.exec_module(review)
class ReviewTests(unittest.TestCase):
    def test_departure_not_lunch_return_and_duplicate_suggestion(self):
        rows=[{'employee_id':'1','name':'Employee','timestamp':'2026-10-12 '+t,'workcode':'','source':'clock'} for t in ['08:00:00','12:00:00','17:00:00']]
        report={'daily':[{'employeeId':'1','values':[None]*15+['review',''],'punches':['08:00:00','12:00:00','17:00:00']}],'totals':[{'employeeId':'1','values':[0]*9}]};report['daily'][0]['values'][2]='2026-10-12'
        review.enrich(report,rows,rows,{})
        self.assertEqual(report['daily'][0]['values'][8],'17:00:00');self.assertEqual(report['daily'][0]['values'][7],'')
        self.assertIn('Lunch in',report['daily'][0]['suggestion']['missing'])
    def test_local_overlay_keeps_originals_and_disabled_punch(self):
        original=[{'employee_id':'1','name':'Employee','timestamp':'2026-10-12 '+t,'workcode':'','source':'clock'} for t in ['08:00:00','12:00:00','12:01:00','13:00:00','17:00:00']]
        before=[dict(r) for r in original];history={('1','2026-10-12'):[{'punches':[{'time':r['timestamp'][11:],'enabled':r['timestamp'][11:]!='12:01:00'} for r in original]}]}
        effective,raw=review.apply_adjustments(original,history,'2026-10-12','2026-10-12');self.assertEqual(len(effective),4);self.assertEqual(raw,before);self.assertEqual(original,before)
        history[('1','2026-10-12')][0]['original']=[r['timestamp'][11:] for r in before]
        original.append({'employee_id':'1','name':'Employee','timestamp':'2026-10-12 18:00:00','workcode':'','source':'clock'})
        effective,raw=review.apply_adjustments(original,history,'2026-10-12','2026-10-12')
        self.assertIn('2026-10-12 18:00:00',[r['timestamp'] for r in effective])
        history[('1','2026-10-12')][0]['restoreOriginal']=1
        restored,_=review.apply_adjustments(original,history,'2026-10-12','2026-10-12')
        self.assertEqual(restored,original)
if __name__=='__main__':unittest.main()
