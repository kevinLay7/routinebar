import importlib.util
import pathlib
import tempfile
import types
import unittest

spec = importlib.util.spec_from_file_location('teams_cache', pathlib.Path(__file__).with_name('teams-cache.py'))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class MacTeamsTests(unittest.TestCase):
    def message(self, **patch):
        return dict({'id': '123', 'conversationId': '19:chat@thread.v2', 'type': 'Message', 'state': 1,
                     'content': b'<p>Kevin, please check &amp; reply.</p>', 'originalArrivalTime': 1792087287702,
                     'properties': {'mentions': '[{"mri":"8:orgid:me","mentionType":"person"}]'}, 'imDisplayName': 'Sender'}, **patch)

    def test_actual_mentions_and_decoded_content(self):
        message = cache.normalize_message(self.message(), '19:chat@thread.v2', '8:orgid:me')
        self.assertTrue(message['mentionedSelf'])
        self.assertEqual(message['text'], 'Kevin, please check & reply.')
        self.assertEqual(message['key'], 'teams:19:chat@thread.v2:123')
        ordinary = cache.normalize_message(self.message(properties={'mentions': '[]'}), '19:chat@thread.v2', '8:orgid:me')
        self.assertFalse(ordinary['mentionedSelf'])
        other = cache.normalize_message(self.message(), '19:chat@thread.v2', '8:orgid:someone-else')
        self.assertFalse(other['mentionedSelf'])

    def test_deleted_and_other_conversation_messages_are_excluded(self):
        for patch in [{'state': 3}, {'deletionInfo': {'time': 123}}, {'conversationId': 'other'}, {'type': 'Activity'}]:
            self.assertIsNone(cache.normalize_message(self.message(**patch), '19:chat@thread.v2', '8:orgid:me'))

    def test_unknown_mention_metadata_is_not_silently_accepted(self):
        for properties in [{}, {'mentions': 'broken'}, {'mentions': '{}'}]:
            with self.assertRaises(ValueError):
                cache.normalize_message(self.message(properties=properties), '19:chat@thread.v2', '8:orgid:me')

    def test_newer_deletion_cannot_resurrect_older_live_copy(self):
        old = self.message(version='1')
        deleted = self.message(version='2', state=3)
        for records in [[old, deleted], [deleted, old]]:
            selected = cache.newest_messages(records)
            self.assertEqual(len(selected), 1)
            self.assertIsNone(cache.normalize_message(selected[0], '19:chat@thread.v2', '8:orgid:me'))

    def test_snapshot_uses_manifest_live_files_and_recovery_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = pathlib.Path(tmp)
            for name in ['CURRENT', 'MANIFEST-000001', '000001.ldb', '000002.ldb', '000003.log', '000004.log', '000005.log']:
                (directory / name).write_text('MANIFEST-000001\n' if name == 'CURRENT' else '')
            def edit(added=(), deleted=(), log=None, previous=None):
                return types.SimpleNamespace(new_files=[types.SimpleNamespace(file_no=n) for n in added], deleted_files=[types.SimpleNamespace(file_no=n) for n in deleted], log_number=log, prev_log_number=previous)
            class Manifest:
                def __init__(self, path):
                    pass
                def __iter__(self):
                    return iter([edit(added=(1,), log=3), edit(added=(2,), deleted=(1,), log=5, previous=4)])
                def close(self):
                    pass
            files, _, _ = cache.current_files(directory, Manifest)
            self.assertEqual({f.name for f in files}, {'CURRENT', 'MANIFEST-000001', '000002.ldb', '000004.log', '000005.log'})
            (directory / '000002.ldb').unlink()
            with self.assertRaises(ValueError):
                cache.current_files(directory, Manifest)


if __name__ == '__main__':
    unittest.main()
