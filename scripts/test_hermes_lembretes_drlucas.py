import os
import sys
import unittest
import datetime
import tempfile
import sqlite3

# Adiciona o diretório scripts ao sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import hermes_lembretes_drlucas as lembretes

class TestHermesLembretes(unittest.TestCase):

    def setUp(self):
        self.temp_db = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
        self.db_path = self.temp_db.name
        self.temp_db.close()
        lembretes.init_db(self.db_path)

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_eligibility_standard_24h(self):
        now = datetime.datetime(2026, 10, 1, 10, 0, 0, tzinfo=datetime.timezone.utc)
        appointment_dt = datetime.datetime(2026, 10, 2, 10, 0, 0, tzinfo=datetime.timezone.utc)
        res = lembretes.check_appointment_eligibility(appointment_dt, now)
        self.assertTrue(res["eligible"])
        self.assertEqual(res["dispatch_type"], "24h_standard")

    def test_eligibility_last_minute(self):
        now = datetime.datetime(2026, 10, 1, 10, 0, 0, tzinfo=datetime.timezone.utc)
        # Consulta em 5h (menos de 24h)
        appointment_dt = datetime.datetime(2026, 10, 1, 15, 0, 0, tzinfo=datetime.timezone.utc)
        res = lembretes.check_appointment_eligibility(appointment_dt, now)
        self.assertTrue(res["eligible"])
        self.assertEqual(res["dispatch_type"], "immediate_last_minute")

    def test_eligibility_too_early(self):
        now = datetime.datetime(2026, 10, 1, 10, 0, 0, tzinfo=datetime.timezone.utc)
        # Consulta em 48h (mais de 25h)
        appointment_dt = datetime.datetime(2026, 10, 3, 10, 0, 0, tzinfo=datetime.timezone.utc)
        res = lembretes.check_appointment_eligibility(appointment_dt, now)
        self.assertFalse(res["eligible"])

    def test_status_callback_persistence(self):
        wamid = "wamid.HBgMOTE5OTk5OTk5OTk5FQIAERg5MDAwMDAwMDAwMAA="
        appointment_dt = datetime.datetime(2026, 10, 2, 10, 0, 0, tzinfo=datetime.timezone.utc)
        
        # 1. Registra o disparo com status inicial 'sent'
        rec_ok = lembretes.record_dispatch("app_1001", "5511999999999", appointment_dt, "24h_standard", wamid, self.db_path)
        self.assertTrue(rec_ok)

        # 2. Simula callback de webhook da Meta com status 'delivered'
        payload_delivered = {
            "entry": [{
                "changes": [{
                    "value": {
                        "statuses": [{
                            "id": wamid,
                            "status": "delivered"
                        }]
                    }
                }]
            }]
        }
        updated = lembretes.process_meta_status_callback(payload_delivered, self.db_path)
        self.assertEqual(updated, 1)

        # 3. Verifica no banco se o status virou 'delivered'
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT status FROM lembretes_disparados WHERE wamid = ?", (wamid,))
        row = cursor.fetchone()
        conn.close()
        self.assertEqual(row[0], "delivered")

if __name__ == "__main__":
    unittest.main()
