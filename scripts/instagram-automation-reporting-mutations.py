"""Mutantes em cópias descartáveis. Exige QA_PG_URL de Postgres exclusivo de teste."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPORT = Path(os.environ.get('SAC_C_QA_OUTPUT', '/tmp/sac-c-validation'))
REPORT.mkdir(parents=True, exist_ok=True)
LIB = Path('src/lib/instagram-automation-reporting.ts')
ROUTE = Path('src/app/api/v1/companies/[idOrSlug]/instagram-automations/[type]/[id]/logs/route.ts')
COMMAND = ['timeout', '570', 'node', '--experimental-test-module-mocks', '--import', 'tsx', '--test', '--test-concurrency=1', 'scripts/instagram-automation-reporting.test.ts']
if not os.environ.get('QA_PG_URL'):
    raise SystemExit('Defina QA_PG_URL para um Postgres descartável exclusivo.')


def fingerprints():
    paths = subprocess.check_output(['git', 'ls-files', '-co', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
    return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(set(paths)) if p and (ROOT / p).is_file()}


# Remover cada defesa deve quebrar uma asserção, não a compilação ou o setup.
mutants = [
    ('company_rules', LIB, 'FROM instagram_comment_automations WHERE company_id = ${companyId}', 'FROM instagram_comment_automations WHERE true'),
    ('company_story_rules', LIB, 'FROM instagram_story_automations WHERE company_id = ${companyId}', 'FROM instagram_story_automations WHERE true'),
    ('company_metrics_logs', LIB, 'WHERE company_id = ${companyId}\n      AND', 'WHERE true\n      AND'),
    ('company_history', LIB, 'WHERE company_id = ${companyId} AND automation_id = ${id}', 'WHERE automation_id = ${id}'),
    ('wrong_status', LIB, "sent: 'enviados', failed: 'falhas'", "sent: 'falhas', failed: 'falhas'"),
    ('period', LIB, 'AND ${timestamp} >= ${period.from}::timestamptz AND ${timestamp} <= ${period.to}::timestamptz', 'AND true'),
    ('sender_mask', LIB, '`****${value.slice(-4)}`', 'value'),
    ('different_404', ROUTE,
     "if (!result) return NextResponse.json({ error: 'Automação não encontrada.' }, { status: 404 })",
     """if (!result) {
      const { db } = await import('@/lib/db')
      const { sql } = await import('drizzle-orm')
      const table = sql.identifier(type === 'comment' ? 'instagram_comment_automations' : 'instagram_story_automations')
      const result = await db.execute(sql`SELECT id FROM ${table} WHERE id = ${id}`)
      const found = (Array.isArray(result) ? result : result.rows).length > 0
      return NextResponse.json({ error: found ? 'Automação pertence a outra empresa.' : 'Automação não encontrada.' }, { status: 404 })
    }"""),
]

before = fingerprints()
(REPORT / 'sha256-before.json').write_text(json.dumps(before, indent=2))
results = []
try:
    with tempfile.TemporaryDirectory(prefix='sac-c-mutants-') as temporary:
        parent = Path(temporary)
        # Dependências compartilhadas apenas no pai, fora de todas as cópias.
        (parent / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        baseline = parent / 'baseline'
        shutil.copytree(ROOT, baseline, ignore=shutil.ignore_patterns('node_modules', '.git', '.next', '*.tsbuildinfo'))
        with (REPORT / 'mutation-baseline.log').open('w') as output:
            base = subprocess.run(COMMAND, cwd=baseline, stdout=output, stderr=subprocess.STDOUT)
        if base.returncode != 0:
            raise RuntimeError(f'Baseline em cópia falhou: exit {base.returncode}')
        results.append({'mutant': 'baseline', 'exit': base.returncode})
        for name, file, old, new in mutants:
            copy = parent / name
            shutil.copytree(baseline, copy)
            target = copy / file
            original = target.read_text()
            if old not in original:
                raise RuntimeError(f'Mutação não aplicada: {name}')
            target.write_text(original.replace(old, new))
            logfile = REPORT / f'mutant-{name}.log'
            with logfile.open('w') as output:
                run = subprocess.run(COMMAND, cwd=copy, stdout=output, stderr=subprocess.STDOUT)
            log = logfile.read_text()
            killed = run.returncode == 1 and 'ERR_ASSERTION' in log and 'hookFailed' not in log
            results.append({'mutant': name, 'exit': run.returncode, 'killed_by_assertion': killed})
            print(json.dumps(results[-1]), flush=True)
            shutil.rmtree(copy)
        if not all(row.get('killed_by_assertion', True) for row in results):
            raise RuntimeError('Um mutante sobreviveu ou falhou por infraestrutura.')
finally:
    after = fingerprints()
    (REPORT / 'sha256-after.json').write_text(json.dumps(after, indent=2))
    (REPORT / 'mutations.json').write_text(json.dumps(results, indent=2))
    if before != after:
        raise RuntimeError('Arquivos do repositório original foram alterados durante os mutantes.')
    print('SHA256 antes/depois idênticos em todos os arquivos de origem.', flush=True)
