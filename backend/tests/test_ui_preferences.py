from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import database
from app.api import auth
from fastapi import HTTPException


class ReminderPreferencesTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.enterContext(patch.object(database, 'DATABASE_BACKEND', 'sqlite'))
        self.enterContext(patch.object(database, 'DB_PATH', str(Path(self.folder.name) / 'test.db')))
        database.init_db()
        conn = database.get_conn()
        conn.execute("INSERT INTO users(user_id,nickname) VALUES(?,?)", ('first', '小月'))
        conn.execute("INSERT INTO users(user_id,nickname) VALUES(?,?)", ('second', '另一位'))
        conn.commit()
        conn.close()

    def test_exclusions_persist_and_profile_patch_preserves_them(self):
        initial = database.get_user_profile('first')
        self.assertTrue(initial['excludeSoundReminder'])
        self.assertTrue(initial['excludeLightReminder'])
        saved = database.update_user_profile('first', {'excludeSoundReminder': False, 'excludeLightReminder': True})
        self.assertFalse(saved['excludeSoundReminder'])
        self.assertTrue(saved['excludeLightReminder'])
        saved = database.update_user_profile('first', {'nickname': '新称呼'})
        self.assertFalse(saved['excludeSoundReminder'])
        self.assertTrue(database.get_user_profile('second')['excludeSoundReminder'])
        self.assertNotIn('vibration', saved)

    def test_existing_database_migration_is_repeatable(self):
        database.update_user_profile('first', {'excludeLightReminder': False})
        database.init_db()
        self.assertFalse(database.get_user_profile('first')['excludeLightReminder'])

    def test_profile_endpoint_accepts_aliases_and_rejects_ambiguous_boolean_values(self):
        with patch.object(auth, '_get_user_from_token', return_value='first'):
            result = auth.save_me_profile(authorization='test', body={'exclude_sound_reminder': False})
            self.assertFalse(result['excludeSoundReminder'])
            self.assertTrue(result['excludeLightReminder'])
            with self.assertRaises(HTTPException) as error:
                auth.save_me_profile(authorization='test', body={'excludeLightReminder': 'false'})
            self.assertEqual(error.exception.status_code, 400)
            self.assertTrue(database.get_user_profile('first')['excludeLightReminder'])
