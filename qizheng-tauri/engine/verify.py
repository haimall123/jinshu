from pathlib import Path
import hashlib
import json
import subprocess

project = Path(__file__).resolve().parent.parent
runtime = project / 'src-tauri/resources/runtime'
executable = runtime / 'bin/moira-engine.exe'
fixtures = json.loads((Path(__file__).parent / 'fixtures.json').read_text(encoding='utf-8'))
for case in fixtures['cases']:
    fields = case['input']
    data = ('moira\n' + '\n'.join(fields) + '\n').encode('utf-8')
    result = subprocess.run([str(executable), '--stdin-path'], input=data, capture_output=True, cwd=runtime, timeout=45)
    if result.returncode or result.stderr:
        raise RuntimeError(f"计算失败 {fields!r}: {result.stderr.decode('utf-8', errors='replace')}")
    actual = hashlib.sha256(result.stdout).hexdigest()
    if actual != case['sha256']:
        raise AssertionError(f"原版对照不一致 {fields!r}: {actual}")
print(f"{len(fixtures['cases'])} combinations match the original Moira output byte-for-byte")
