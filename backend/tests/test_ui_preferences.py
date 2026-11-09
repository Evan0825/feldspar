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
        self.assertFalse(initial['excludeSoundReminder'])
        self.assertFalse(initial['excludeLightReminder'])
        saved = database.update_user_profile('first', {'excludeSoundReminder': False, 'excludeLightReminder': True})
        self.assertFalse(saved['excludeSoundReminder'])
        self.assertTrue(saved['excludeLightReminder'])
        saved = database.update_user_profile('first', {'nickname': '新称呼'})
        self.assertFalse(saved['excludeSoundReminder'])
        self.assertFalse(database.get_user_profile('second')['excludeSoundReminder'])
        self.assertNotIn('vibration', saved)

    def test_existing_database_migration_is_repeatable(self):
        database.update_user_profile('first', {'excludeLightReminder': False})
        database.init_db()
        self.assertFalse(database.get_user_profile('first')['excludeLightReminder'])

    def test_profile_endpoint_accepts_aliases_and_rejects_ambiguous_boolean_values(self):
        with patch.object(auth, '_get_user_from_token', return_value='first'):
            result = auth.save_me_profile(authorization='test', body={'exclude_sound_reminder': False})
            self.assertFalse(result['excludeSoundReminder'])
            self.assertFalse(result['excludeLightReminder'])
            with self.assertRaises(HTTPException) as error:
                auth.save_me_profile(authorization='test', body={'excludeLightReminder': 'false'})
            self.assertEqual(error.exception.status_code, 400)
            self.assertFalse(database.get_user_profile('first')['excludeLightReminder'])

    def test_login_preserves_saved_exclusions_and_new_accounts_get_enabled_defaults(self):
        database.update_user_profile('first', {'excludeSoundReminder': True, 'excludeLightReminder': True})
        database.upsert_user_session('first', 'openid-first', 'token-first', 9999999999)
        database.upsert_user_session('new-user', 'openid-new', 'token-new', 9999999999)
        self.assertTrue(database.get_user_profile('first')['excludeSoundReminder'])
        self.assertTrue(database.get_user_profile('first')['excludeLightReminder'])
        self.assertFalse(database.get_user_profile('new-user')['excludeSoundReminder'])
        self.assertFalse(database.get_user_profile('new-user')['excludeLightReminder'])

    def test_new_account_overrides_legacy_column_defaults_without_resetting_old_choices(self):
        conn = database.get_conn()
        schema = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").fetchone()['sql']
        schema = schema.replace('exclude_sound_reminder INTEGER NOT NULL DEFAULT 0', 'exclude_sound_reminder INTEGER NOT NULL DEFAULT 1').replace('exclude_light_reminder INTEGER NOT NULL DEFAULT 0', 'exclude_light_reminder INTEGER NOT NULL DEFAULT 1')
        conn.execute('DROP TABLE users')
        conn.execute(schema)
        conn.execute("INSERT INTO users(user_id) VALUES(?)", ('old-account',))
        conn.commit()
        conn.close()
        database.upsert_user_session('new-account', 'openid-new', 'new-token', 9999999999)
        database.upsert_user_session('old-account', 'openid-old', 'old-token', 9999999999)
        self.assertFalse(database.get_user_profile('new-account')['excludeSoundReminder'])
        self.assertFalse(database.get_user_profile('new-account')['excludeLightReminder'])
        self.assertTrue(database.get_user_profile('old-account')['excludeSoundReminder'])
        self.assertTrue(database.get_user_profile('old-account')['excludeLightReminder'])
