"""Check calendar conversion against independent .NET Chinese calendar fixtures."""
from pathlib import Path
import json
import subprocess

project = Path(__file__).resolve().parent.parent
runtime = project / 'src-tauri/resources/runtime'
executable = runtime / 'bin/moira-engine.exe'
fixtures = json.loads((Path(__file__).parent / 'calendar-fixtures.json').read_text(encoding='utf-8'))


def convert(date, mode):
    fields = ['calendar', '1', *map(str, date), '12', '0', '116.4', '39.9', '8']
    result = subprocess.run([str(executable), '--stdin-path', mode],
                            input=('moira\n' + '\n'.join(fields) + '\n').encode('utf-8'),
                            cwd=runtime, capture_output=True, timeout=30)
    return result.returncode, result.stdout.decode('utf-8')


count = 0
for case in fixtures['cases']:
    lunar = case['lunar']
    expected = [*case['solar'], *lunar, int(case['leap'])]
    mode = '--lunar-leap' if case['leap'] else '--lunar'
    for date, flag in [(lunar, mode), (case['solar'], '--solar')]:
        code, output = convert(date, flag)
        assert code == 0 and list(map(int, output.split())) == expected, (case, flag, code, output)
        count += 1

for date, flag in [([2024, 2, 30], '--solar'), ([2024, 1, 1], '--lunar-leap'),
                   ([2023, 2, 30], '--lunar-leap'), ([1982, 4, 30], '--lunar-leap'),
                   ([2024, 0, 1], '--lunar'), ([2024, 13, 1], '--lunar'),
                   ([2024, 1, 31], '--lunar'), ([2100, 12, 30], '--lunar')]:
    code, output = convert(date, flag)
    assert code != 0 and output.startswith('ERROR:'), (date, flag, output)
    count += 1

for date in [[1800, 2, 1], [1850, 6, 1], [2100, 12, 31]]:
    code, output = convert(date, '--solar')
    assert code == 0, output
    values = list(map(int, output.split()))
    code, reverse = convert(values[3:6], '--lunar-leap' if values[6] else '--lunar')
    assert code == 0 and list(map(int, reverse.split())) == values, (date, output, reverse)
    count += 2

print(f'{count} calendar checks passed; independent fixtures, leap months, invalid dates and range boundaries')
