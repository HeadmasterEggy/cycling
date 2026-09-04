import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import analyze_delivery as analysis

class Suburbs:
    def lookup(self, lat, lon):
        return 'Area A' if lat == 1 else None

class PlanningTests(unittest.TestCase):
    def test_intervals_split_at_local_hour_and_midnight_without_dropping_quiet_time(self):
        t = datetime(2026, 8, 29, 23, 59, 50, tzinfo=analysis.SYD_TZ)
        shift = {'date': '2026-08-29', 'samples': [{'t': t, 'dt': 20, 'lat': 1, 'lon': 1}],
                 'dwells': [{'t': t.astimezone(timezone.utc), 'zone':'Area A', 'kind':'pickup', 'secs':65}]}
        p = analysis.build_planning([shift], Suburbs())
        self.assertEqual([(c['date'],c['hour'],c['seconds'],c['pickups']) for c in p['cells']],
                         [('2026-08-29',23,10,1),('2026-08-30',0,10,0)])
        self.assertEqual([c['weekday'] for c in p['cells']],[5,6])
        self.assertEqual(p['recent_anchor'],'2026-08-30')
        self.assertEqual(p['cells'][0]['wait_s'],[65])
        self.assertFalse(any(k in c for c in p['cells'] for k in ('lat','lon','address','venue')))

    def test_daylight_saving_does_not_create_a_nonexistent_hour(self):
        t = datetime(2026,10,4,1,59,50,tzinfo=analysis.SYD_TZ)
        shift = {'date':'2026-10-04','samples':[{'t':t,'dt':20,'lat':1,'lon':1}],'dwells':[]}
        cells = analysis.build_planning([shift],Suburbs())['cells']
        self.assertEqual([(c['hour'],c['seconds']) for c in cells],[(1,10),(3,10)])

    def test_suburb_boundary_cache_does_not_change_a_previous_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'suburbs.json'
            path.write_text(json.dumps([{'name':'Area A','rings':[[[151, -34], [152,-34], [152,-33], [151,-33], [151,-34]]]}]))
            index = analysis.SuburbIndex(path)
            # Points on opposite sides share the old rounded cache key.
            self.assertIsNone(index.lookup(-33.5,150.99999))
            self.assertEqual(index.lookup(-33.5,151.00001),'Area A')
            self.assertIsNone(index.lookup(-33.5,150.99999))

    def test_sydney_four_am_week_boundary(self):
        before = datetime(2026,8,24,3,59,59,tzinfo=analysis.SYD_TZ).timestamp()
        self.assertEqual(analysis._stmt_week(before),'2026-08-17')
        self.assertEqual(analysis._stmt_week(before+1),'2026-08-24')

    def test_quest_is_separate_and_deduplication_is_one_to_one(self):
        ts = int(datetime(2026,8,25,12,tzinfo=analysis.SYD_TZ).timestamp())
        rows = [f'{ts}|TRIP|8.27|600|2||', f'{ts+1}|CT|5.10|400|1||',
                f'{ts+1000}|QUEST|20',f'{ts+1001}|MISC|20',f'{ts+1002}|MISC|20',
                f'{ts+2000}|MISC|-3',f'{ts+3000}|MISC|250']
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'activity.psv'
            path.write_text('\n'.join(rows))
            e = analysis.read_earnings(path)
            w = e['weeks']['2026-08-24']
            self.assertAlmostEqual(w['fare'],13.37)
            self.assertEqual(w['quest'],20)
            self.assertEqual(w['other'],17)
            self.assertEqual(w['per_order'],10)
            self.assertEqual(e['dupes'],1)
            self.assertEqual(e['one_offs'],[{'on':'2026-08-24','amt':250}])
            offers = analysis.build_offers(path, [], None)
            self.assertFalse(offers['acceptance_time_available'])
            for c in offers['statement_checks']:
                self.assertAlmostEqual(c['fare']+c['quest']+c['other']+c['tips'],c['total'])

    def test_pickup_frequency_does_not_reward_dropoffs_or_riding_score(self):
        rows = [{'hours':2,'shifts':4,'pickups':8,'orders':100,'flow':90},
                {'hours':2,'shifts':4,'pickups':8,'orders':0,'flow':10},
                {'hours':.5,'shifts':4,'pickups':8}]
        analysis.score_worth(rows)
        self.assertEqual([r['worth'] for r in rows],[4,4,None])

    def test_published_exposure_and_events_are_consistent(self):
        data = json.loads((Path(__file__).resolve().parents[1]/'delivery_data.json').read_text())
        cells = data['planning']['cells']
        self.assertTrue(any(c['seconds']>0 and c['pickups']==0 for c in cells))
        for zone in data['zones']:
            local = [c for c in cells if c['zone']==zone['name']]
            self.assertAlmostEqual(sum(c['seconds'] for c in local)/3600,zone['hours'],delta=.006)
            self.assertEqual(sum(c['pickups'] for c in local),zone['pickups'])
            self.assertEqual(sum(c['drops'] for c in local),zone['orders'])
        chain = data['chain']
        self.assertAlmostEqual(chain['matched_km']/chain['observed_km']*100,chain['coverage_pct'],delta=.1)
        self.assertLess(chain['coverage_pct'],100)

if __name__ == '__main__':
    unittest.main()
