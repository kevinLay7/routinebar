#!/usr/bin/env python3
"""Read current records from a temporary snapshot of the Mac Teams message cache."""
import dataclasses
import datetime as dt
import json
import pathlib
import re
import shutil
import sys
import tempfile
from html.parser import HTMLParser
from urllib.parse import quote


class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        if tag in ('p', 'br', 'li', 'div'):
            self.parts.append('\n')


def newest_messages(records):
    latest = {}
    for message in records:
        message_id = str(message.get('id', ''))
        if not message_id:
            continue
        version = float(message.get('version', 0))
        if message_id not in latest or version > latest[message_id][0]:
            latest[message_id] = (version, message)
    return [message for _, message in latest.values()]


def normalize_message(message, chat_id, self_id):
    if message.get('conversationId') != chat_id or message.get('type') != 'Message':
        return None
    deletion = message.get('deletionInfo')
    if isinstance(deletion, dict) or message.get('state') != 1 or message.get('messageType') in ('ThreadActivity/Delete', 'Event/MessageDeleted'):
        return None
    content = message.get('content')
    if isinstance(content, bytes):
        content = content.decode('utf-8', errors='replace')
    if not isinstance(content, str):
        return None
    raw_mentions = message.get('properties', {}).get('mentions')
    if not isinstance(raw_mentions, (str, list)):
        raise ValueError('Teams cache message has no readable mention metadata. Open the chat in Teams and retry.')
    mentions = json.loads(raw_mentions) if isinstance(raw_mentions, str) else raw_mentions
    if not isinstance(mentions, list) or any(not isinstance(m, dict) for m in mentions):
        raise ValueError('Teams mention metadata has changed; update the Mac cache reader.')
    parser = Text()
    parser.feed(content)
    timestamp = message.get('originalArrivalTime')
    if not isinstance(timestamp, (int, float)):
        raise ValueError('Teams cache message is missing its timestamp.')
    message_id = str(message['id'])
    return {
        'id': message_id,
        'key': f'teams:{chat_id}:{message_id}',
        'url': f'https://teams.microsoft.com/l/message/{quote(chat_id, safe="")}/{quote(message_id, safe="")}?context=%7B%22contextType%22%3A%22chat%22%7D',
        'sentAt': dt.datetime.fromtimestamp(timestamp / 1000, dt.timezone.utc).isoformat(),
        'sender': message.get('imDisplayName', ''),
        'text': ''.join(parser.parts).strip(),
        'mentionedSelf': any(m.get('mri') == self_id and m.get('mentionType') == 'person' for m in mentions),
    }


def current_files(directory, manifest_type):
    manifest_name = (directory / 'CURRENT').read_text().strip()
    if not re.fullmatch(r'MANIFEST-\d+', manifest_name):
        raise ValueError('Invalid Teams cache manifest.')
    manifest_path = directory / manifest_name
    stamp = manifest_path.stat().st_size
    manifest = manifest_type(manifest_path)
    active, log_number, previous_log = set(), 0, 0
    try:
        for edit in manifest:
            active.difference_update(f.file_no for f in edit.deleted_files)
            active.update(f.file_no for f in edit.new_files)
            if edit.log_number is not None:
                log_number = edit.log_number
            if edit.prev_log_number is not None:
                previous_log = edit.prev_log_number
    finally:
        manifest.close()
    files = [directory / 'CURRENT', manifest_path]
    for file in directory.iterdir():
        if not re.fullmatch(r'\d+\.(ldb|sst|log)', file.name):
            continue
        number = int(file.stem)
        if file.suffix in ('.ldb', '.sst') and number in active:
            files.append(file)
        elif file.suffix == '.log' and (number >= log_number or number == previous_log):
            files.append(file)
    if not active or not active.issubset({int(f.stem) for f in files if f.suffix in ('.ldb', '.sst')}):
        raise ValueError('Teams cache changed during snapshot. Retry the check.')
    return files, manifest_name, stamp


def read_cache(config, previous_keys):
    from ccl_chromium_reader.ccl_chromium_indexeddb import IndexedDb, WrappedDatabase
    from ccl_chromium_reader.storage_formats.ccl_leveldb import ManifestFile, KeyState, FileType

    if config.get('source') != 'chat':
        raise ValueError('Mac Teams monitoring currently supports group chats. Choose Group chat and paste its link.')
    chat_id = config['chatId']
    if not re.fullmatch(r'19:[\w.-]+@(?:thread\.v2|unq\.gbl\.spaces)', chat_id):
        raise ValueError('Invalid Teams chat ID.')
    root = pathlib.Path.home() / 'Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView'
    candidates = sorted(root.glob('*/IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb'))
    if not candidates:
        raise ValueError('Mac Teams cache not found. Open Microsoft Teams and sign in on this Mac.')
    if len(candidates) != 1:
        raise ValueError('Multiple Mac Teams profiles found. Profile selection is required before monitoring.')
    source = candidates[0]
    cache_written_at = max(f.stat().st_mtime for f in source.iterdir())
    if dt.datetime.now().timestamp() - cache_written_at > 3600:
        raise ValueError('Mac Teams cache has not changed in over an hour. Open Teams, let it sync, and retry.')
    wanted = chat_id.encode('utf-16-be')

    class LiveDb(IndexedDb):
        def _cache_records(self):
            latest = {}
            for record in self._db.iterate_records_raw():
                key = record.user_key
                db_width, store_width = ((key[0] >> 5) & 7) + 1, ((key[0] >> 2) & 7) + 1
                store_id = int.from_bytes(key[1 + db_width:1 + db_width + store_width], 'little')
                if store_id and wanted not in key:
                    continue
                if key not in latest or latest[key].seq < record.seq:
                    latest[key] = record
            self._fetched_records = [dataclasses.replace(r, key=r.user_key, file_type=FileType.Log)
                                     for r in latest.values() if r.state == KeyState.Live]

    with tempfile.TemporaryDirectory(prefix='routinebar-teams-') as temporary:
        dest = pathlib.Path(temporary) / 'db'
        dest.mkdir()
        files, manifest, stamp = current_files(source, ManifestFile)
        for file in files:
            shutil.copy2(file, dest / file.name)
        blob = pathlib.Path(str(source).replace('.leveldb', '.blob'))
        dest_blob = pathlib.Path(temporary) / 'blob'
        if blob.is_dir():
            shutil.copytree(blob, dest_blob)
        if (source / 'CURRENT').read_text().strip() != manifest or (source / manifest).stat().st_size != stamp:
            raise ValueError('Teams compacted its cache during the snapshot. Retry the check.')
        db = LiveDb(dest, dest_blob)
        try:
            found, records, self_ids = [], [], set()
            for identity in db.global_metadata.db_ids:
                if not identity.name.startswith(('Teams:conversation-manager:', 'Teams:replychain-manager:')):
                    continue
                database = WrappedDatabase(db, identity)
                for store in database:
                    if store.name not in ('conversations', 'replychains', 'replychains-2'):
                        continue
                    for record in store.iterate_records():
                        value = record.value
                        if not isinstance(value, dict):
                            continue
                        if store.name == 'conversations' and value.get('id') == chat_id:
                            found.append(value)
                        elif value.get('conversationId') == chat_id:
                            for message in value.get('messageMap', {}).values():
                                if isinstance(message, dict) and message.get('conversationId') == chat_id:
                                    records.append(message)
                                    if message.get('isSentByCurrentUser') and isinstance(message.get('creator'), str):
                                        self_ids.add(message['creator'])
            if len(found) != 1:
                raise ValueError('Chat is not uniquely available in the Mac cache. Open the configured chat in Teams and retry.')
            if len(self_ids) != 1:
                raise ValueError('Could not confirm the signed-in user from the cached chat. Open the chat in Teams and retry.')
            self_id = next(iter(self_ids))
            conversation = found[0]
            cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=config['lookbackHours'])
            messages = {}
            for record in newest_messages(records):
                sent = record.get('originalArrivalTime')
                key = f"teams:{chat_id}:{record.get('id')}"
                if isinstance(sent, (float, int)) and dt.datetime.fromtimestamp(sent / 1000, dt.timezone.utc) < cutoff and key not in previous_keys:
                    continue
                message = normalize_message(record, chat_id, self_id)
                if not message:
                    continue
                if dt.datetime.fromisoformat(message['sentAt']) >= cutoff or message['key'] in previous_keys:
                    if message['id'] not in messages or float(record.get('version', 0)) > messages[message['id']][0]:
                        messages[message['id']] = (float(record.get('version', 0)), message)
            selected = sorted((m for _, m in messages.values()), key=lambda m: m['sentAt'])
            missing = [key for key in previous_keys if key != 'teams:access' and key not in {m['key'] for m in selected}]
            latest_at = conversation.get('lastContentMessageTime')
            if not selected and records and not isinstance(latest_at, str):
                raise ValueError('Teams cache coverage could not be verified. Open the chat in Teams and retry.')
            return {
                'source': 'mac-teams-cache', 'chatId': chat_id, 'selfId': self_id,
                'capturedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                'cacheWrittenAt': dt.datetime.fromtimestamp(cache_written_at, dt.timezone.utc).isoformat(),
                'lastCachedMessageAt': latest_at if isinstance(latest_at, str) else None,
                'coverage': 'Only messages downloaded by the Mac Teams client are available. This snapshot cannot prove complete server history or live sync.',
                'messages': selected, 'missingPreviousKeys': missing,
            }
        finally:
            db.close()


def main():
    try:
        request = json.loads(sys.stdin.read())
        result = read_cache(request['config'], request.get('previousKeys', []))
        output = json.dumps(result, ensure_ascii=False)
        if len(output.encode()) > 2000000:
            raise ValueError('Too many cached messages for this lookback window. Choose a shorter window.')
        print(output)
    except Exception as error:
        message = str(error) if isinstance(error, (ValueError, FileNotFoundError, PermissionError, ModuleNotFoundError)) else 'Mac Teams cache could not be decoded. Open Teams and retry; its cache format may have changed.'
        print(json.dumps({'error': message}), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
