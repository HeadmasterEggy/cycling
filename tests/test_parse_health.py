import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import parse_health as ph

class ExportOffsetTests(unittest.TestCase):
    def test_body_records_use_the_zone_of_the_latest_ride_not_the_export_offset(self):
        rides = [{'start_iso': '2026-01-12T20:00:00+11:00', 'city': 'Sydney'},
                 {'start_iso': '2026-06-10T09:00:00+08:00', 'city': 'Ningbo'},
                 {'start_iso': '2026-07-27T20:00:00+10:00', 'city': 'Sydney'}]
        zone_at = ph.zone_timeline(rides)
        # A winter Sydney record exported in summer carries +1100.
        dt = ph.parse_dt('2026-08-01 00:30:00 +1100')
        self.assertEqual(dt.astimezone(zone_at(dt)).strftime('%Y-%m-%d %H'), '2026-07-31 23')
        dt = ph.parse_dt('2026-06-20 12:00:00 +1100')
        self.assertEqual(dt.astimezone(zone_at(dt)).hour, 9)

if __name__ == '__main__':
    unittest.main()
