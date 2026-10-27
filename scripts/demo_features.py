"""Synthetic fixture only. No device, network, recordings or efficacy claims."""
from pathlib import Path
import json
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'backend'))
from app.audio.feature_contract import FeatureTracker, FeatureWindow

def packet(sequence, **changes):
    return FeatureWindow(protocol_version='feldspar-features-v1', device_id='synthetic-test',
        session_id='fixture-a', sequence=sequence, timestamp_ms=1000000+sequence*1000,
        monotonic_end_ms=sequence*1000, clock_valid=True, sample_rate=16000,
        sample_count=16000, window_ms=1000, context_blocks=300,
        rms=.1, clipped_ratio=0, band_ratio=.9, volume_ratio=4,
        periodicity=.9, **{'quality_flags': 0, **changes})

tracker = FeatureTracker()
for sequence in range(1, 31):
    result = tracker.observe(packet(sequence), 1000000+sequence*1000)
assert result['automatic_allowed'] is False
assert result['valid_windows'] == 30
invalid = tracker.observe(packet(31, quality_flags=2), 1031000)
assert invalid['rating'] == 'unknown' and invalid['valid_windows'] == 0
print(json.dumps({'source': 'synthetic_fixture', 'valid_30_windows': result,
    'self_noise_window': invalid, 'limitation': 'Engineering rules only; not clinical or classifier validation.'}, ensure_ascii=False, indent=2))
