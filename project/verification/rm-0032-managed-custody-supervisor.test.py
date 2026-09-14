"""Offline checks for confinement arguments and owned-unit settlement."""
import asyncio
import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).with_name('rm-0032-managed-custody-supervisor.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SupervisorTests(unittest.TestCase):
    def test_source_binding(self):
        source = '# reviewed\n' + ('pass\n' * 30)
        item = {'source': source, 'sha256': hashlib.sha256(source.encode()).hexdigest()}
        self.assertEqual(m.validate_bundle({'relay': item, 'client': item})['relay'], item)
        with self.assertRaises(m.Refused):
            m.validate_bundle({'relay': dict(item, source=source + 'pass\n'), 'client': item})

    def test_listener_scope(self):
        def table(address, state='0A'):
            return 'header\n0: ' + address + ':480B 00000000:0000 ' + state + '\n'
        for address in ('00000000', '0200007F', '0' * 32,
                        '0000000000000000FFFF00000200007F'):
            self.assertFalse(m.exclusive_addresses_clear({'tcp': table(address)}))
        self.assertTrue(m.exclusive_addresses_clear({'tcp': table('0100007F')}))
        self.assertTrue(m.exclusive_addresses_clear({'tcp': table('0200007F', '01')}))
        self.assertFalse(m.exclusive_addresses_clear({'udp': table('00000000', '07')}))

    def test_unit_confinement(self):
        relay = m.unit_argv(m.RELAY, 'pass')
        client = m.unit_argv(m.CLIENT, 'pass')
        self.assertIn('--property=InaccessiblePaths=' + m.AUTH, relay)
        self.assertIn('--uid=65534', relay)
        self.assertIn('--uid=20000', client)
        self.assertIn('--property=IPAddressDeny=any', client)
        self.assertIn('--property=IPAddressAllow=127.0.0.2/32', client)
        self.assertIn('HTTPS_PROXY=http://127.0.0.2:18443', client)
        for argv in (relay, client):
            self.assertIn('--property=CapabilityBoundingSet=', argv)
            self.assertIn('--property=NoNewPrivileges=yes', argv)
            self.assertIn('--property=ProtectSystem=strict', argv)
            self.assertIn('--collect', argv)
            self.assertNotIn('--remain-after-exit', argv)
            self.assertIn('-i', argv)

    def test_unknown_unit_is_not_stopped(self):
        async def check():
            with patch.object(m, 'snapshot', AsyncMock(return_value={'Description': 'someone else'})), \
                 patch.object(m, 'control', AsyncMock()) as control:
                self.assertFalse(await m.settle_owned(m.CLIENT))
                control.assert_not_called()
        asyncio.run(check())

    def test_exact_unit_stop_and_readback(self):
        async def check():
            before = {'Description': m.DESCRIPTIONS[m.RELAY], 'User': '65534', 'Group': '65534'}
            after = {'LoadState': 'not-found', 'ActiveState': 'inactive', 'MainPID': '0'}
            with patch.object(m, 'snapshot', AsyncMock(side_effect=[before, after])), \
                 patch.object(m, 'control', AsyncMock(return_value=(0, b''))) as control:
                self.assertTrue(await m.settle_owned(m.RELAY))
                control.assert_awaited_once_with(['/usr/bin/systemctl', 'stop', m.RELAY], 15)
        asyncio.run(check())

    def test_stream_is_retained_bounded_but_drained(self):
        async def check():
            reader = asyncio.StreamReader()
            reader.feed_data(b'x' * 10000)
            reader.feed_eof()
            data, count = await m.bounded_read(reader, 128)
            self.assertEqual(len(data), 128)
            self.assertEqual(count, 10000)
        asyncio.run(check())

    def test_relay_schema_rejects_raw_fields_and_counts(self):
        value = {'version': 1, 'settled': True, 'counters': {k: 0 for k in
            ('accepted', 'over_limit', 'refused', 'connected', 'completed', 'failed', 'cancelled', 'internal_error')}}
        self.assertEqual(m.normalize_relay(value), value)
        for bad in (dict(value, raw='private'), dict(value, version=True),
                    dict(value, counters=dict(value['counters'], accepted=65)),
                    dict(value, counters=dict(value['counters'], failed='private'))):
            with self.assertRaises(m.Refused):
                m.normalize_relay(bad)

    def test_bound_client_normalization_rejects_private_fields(self):
        source = Path(__file__).with_name('rm-0032-managed-custody-client.py').read_text()
        namespace = {'__name__': 'offline_schema_test'}
        exec(compile(source, '<offline-client>', 'exec'), namespace)
        normalize = m.client_normalizer(source)
        value = namespace['base_result']()
        self.assertEqual(normalize(value), value)
        for bad in (dict(value, account=dict(value['account'], email='private')),
                    dict(value, stage='private'), dict(value, raw='private')):
            with self.assertRaises(ValueError):
                normalize(bad)


if __name__ == '__main__':
    unittest.main()
