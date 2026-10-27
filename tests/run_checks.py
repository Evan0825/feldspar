"""Host regression checks only; does not connect to or flash any device."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='feldspar-host-') as folder:
    executable = str(Path(folder) / 'mic-check')
    subprocess.run(['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
                    '-fsanitize=undefined', '-I', str(root/'firmware/components/mic/include'),
                    str(root/'tests/mic_samples_test.c'), '-o', executable], check=True)
    subprocess.run([executable], check=True)
    guard_component = root/'firmware/components/actuation_guard'
    guard_sources = [str(guard_component/'actuation_guard.c'), str(guard_component/'button_gesture.c')]
    includes = [str(guard_component/'include')]
    for name in ('actuation_guard', 'haptic_adapter'):
        target = str(Path(folder)/name)
        extra = [] if name == 'actuation_guard' else [str(root/'tests/esp_stubs'),
            *[str(root/f'firmware/components/{c}/include') for c in ('haptic', 'device_control', 'audio', 'lighting', 'sfx')]]
        subprocess.run(['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
            '-fsanitize=address,undefined', *[flag for p in includes+extra for flag in ('-I', p)],
            str(root/f'tests/{name}_test.c'), *guard_sources, '-o', target], check=True)
        subprocess.run([target], check=True)
    feature_dir = root/'firmware/components/acoustic_features'
    feature_test = str(Path(folder)/'acoustic-features')
    subprocess.run(['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
        '-fsanitize=address,undefined', '-I', str(feature_dir/'include'), '-I', str(feature_dir),
        str(root/'tests/acoustic_features_test.c'), str(feature_dir/'acoustic_features.c'),
        str(feature_dir/'af_fft512.c'), '-lm', '-o', feature_test], check=True)
    subprocess.run([feature_test], check=True)
    link_dir = root/'firmware/components/device_link'
    frame_test = str(Path(folder)/'link-frames')
    subprocess.run(['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
        '-fsanitize=address,undefined', '-I', str(link_dir/'include'),
        str(root/'tests/link_frames_test.c'), str(link_dir/'link_frames.c'), '-o', frame_test], check=True)
    subprocess.run([frame_test], check=True)
    link_test = str(Path(folder)/'device-link')
    include_paths = [root/'tests/esp_stubs', root/'tests/vendor/cJSON',
        *[root/f'firmware/components/{c}/include' for c in ('device_link', 'acoustic_features', 'haptic', 'actuation_guard', 'mqtt_mgr', 'device_control')]]
    cjson_object = str(Path(folder)/'cjson.o')
    # Keep upstream test-only cJSON intact; macOS deprecates its sprintf API.
    subprocess.run(['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
        '-Wno-deprecated-declarations', '-fsanitize=address,undefined',
        '-c', str(root/'tests/vendor/cJSON/cJSON.c'), '-o', cjson_object], check=True)
    subprocess.run(['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
        '-fsanitize=address,undefined', *[flag for p in include_paths for flag in ('-I', str(p))],
        str(root/'tests/device_link_test.c'), str(link_dir/'link_frames.c'),
        cjson_object, '-lm', '-o', link_test], check=True)
    subprocess.run([link_test], check=True)
    sfx_test = str(Path(folder)/'sfx-stop')
    sfx_includes = [root/'tests/esp_stubs', *[root/f'firmware/components/{c}/include' for c in ('sfx','audio','storage')]]
    subprocess.run(['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
        '-fsanitize=address,undefined', *[flag for p in sfx_includes for flag in ('-I', str(p))],
        '-DSFX_DIR="'+str(Path(folder)/'audio')+'"', str(root/'tests/sfx_stop_test.c'), '-lm', '-o', sfx_test], check=True)
    subprocess.run([sfx_test], check=True)
subprocess.run(['node', '--test', *map(str, sorted((root/'tests').glob('*.test.cjs')))], check=True)
