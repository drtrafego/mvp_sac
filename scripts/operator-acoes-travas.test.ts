import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]) }
const roots = ['src/lib/operator', 'src/app/api/operator', 'src/components/operator']
const sources = roots.flatMap(files)
test('T-TRAVA1-C e T-TRAVA2-B imports, chamadas e campos proibidos ausentes', () => {
  for (const name of sources) {
    const text = readFileSync(name, 'utf8')
    assert.doesNotMatch(text, /bot_paused|botPaused|company_pause_switches|companyPauseSwitches|pause-all|pause-channel|pause-bot|ai_enabled|aiEnabled/, name)
    const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text
        assert.doesNotMatch(spec, /@\/lib\/(?:bot-pause|pessoa-tag-pause|gabi-pause-mirror|lead-tags|instagram|outbound-send|ai-bridge|codex-gateway-client)|whatsapp|send|dispatch|mass-/, name)
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(ast)
        assert.doesNotMatch(expression, /\b(?:transaction|batch)\b/, name)
        if (name.startsWith('src/lib/operator') && !name.endsWith('/model-adapter.ts')) assert.doesNotMatch(expression, /fetch/, name)
        if (expression === 'import' || expression === 'require') {
          const arg = node.arguments[0]
          assert.ok(arg && ts.isStringLiteral(arg), `Import dinâmico não verificável: ${name}`)
          assert.doesNotMatch(arg.text, /bot-pause|pessoa-tag-pause|gabi-pause-mirror|lead-tags|instagram|outbound-send|ai-bridge|codex-gateway-client|whatsapp|send|dispatch|mass-/)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    if (name.includes('/acoes/')) assert.doesNotMatch(text, /\bALTER\s+TABLE\b/i, name)
  }
})
test('T-ADIT-1 apenas E1 a E6 existentes editados, nenhuma exclusão ou migração', () => {
  const names = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  const allChanged = [...new Set([
    ...names(['diff', 'origin/main...HEAD', '--name-only', '--diff-filter=M']),
    ...names(['diff', 'HEAD', '--name-only', '--diff-filter=M']),
    ...names(['diff', '--name-only', '--diff-filter=M']),
  ])].sort()
  const changed = allChanged.filter(name => !name.startsWith('scripts/operator-fase0'))
  assert.deepEqual(changed, ['src/lib/operator/model-adapter.ts', 'src/lib/operator/service.ts', 'src/lib/operator/privacy.ts', 'src/app/api/operator/messages/route.ts', 'src/components/operator/operator-console.tsx', 'src/app/(dashboard)/operar/page.tsx'].sort())
  assert.deepEqual([...new Set([
    ...names(['diff', 'origin/main...HEAD', '--name-only', '--diff-filter=D']),
    ...names(['diff', 'HEAD', '--name-only', '--diff-filter=D']),
    ...names(['diff', '--name-only', '--diff-filter=D']),
  ])], [])
  const added = [...new Set([
    ...names(['diff', 'origin/main...HEAD', '--name-only', '--diff-filter=A']),
    ...names(['diff', 'HEAD', '--name-only', '--diff-filter=A']),
    ...names(['ls-files', '--others', '--exclude-standard']),
  ])]
  assert.ok(added.every(n => /^(src\/lib\/operator\/acoes\/|src\/app\/api\/operator\/|src\/components\/operator\/|scripts\/operator-acoes-)/.test(n)))
})
test('T-PII-LISTA vocabulário acrescentado não inclui prenomes brasileiros', () => {
  // Lista de referência fixa, independente do dicionário de intenções.
  const names = `Maria Ana Francisca Antonia Adriana Juliana Marcia Fernanda Patricia Aline Sandra Camila Amanda Bruna Jessica Leticia Julia Luciana Vanessa Mariana Gabriela Vera Vitoria Larissa Claudia Beatriz Rita Luana Sonia Renata Eliane Josefa Simone Natalia Cristiane Daniela Aparecida Marta Andrea Fatima Jaqueline Monique Cristina Rosangela Helena Alice Janaina Terezinha Lais Marlene Danielle Eduarda Bianca Rosana Michele Tania Renilda Joana Valeria Raquel Iara Isabela Isabel Elza Neusa Lourdes Sueli Silvia Cecilia Marisa Regina Denise Debora Eliana Katia Marilene Ivone Lucia Rosa Rafaela Flavia Roberta Priscila Milena Luiza Heloisa Elisa Esther Manuela Maitê Marilia Geovana Giovanna Yasmin Lorena Rebeca Caroline Carolina Mariane Mariele Nicole Isadora Melissa Valentina Eloisa Clarice Cintia Ivana Ingrid Taiane Tamara Tainara Talita Thais Viviane Vania Valdete Solange Suelen Sabrina Samara Samira Suzana Sheila Shirley Silvana Sara Salete Nair Norma Noemia Nelma Nadia Nara Marilda Maristela Marizete Margarete Madalena Lidia Luciene Lucilene Leonor Leila Lavinia Kelly Karina Karen Jussara Josiane Josilene Joelma Ivete Ilza Hilda Heloise Gisele Graziele Gloria Geralda Francislayne Fabiana Elizete Elisangela Elenice Elaine Edna Dulce Doraci Doralice Dalva Daiane Cibele Celia Carmem Carmelita Carla Cassia Cacilda Benedita Aurora Aurea Angela Angelica Alice Alessandra Adriane Abigail Acacia Albertina Alzira Amalia Amelia Anita Antonieta Arlete Barbara Bernadete Catarina Cleide Conceicao Consuelo Dalila Dolores Elvira Emilia Erica Esmeralda Eugenia Eva Evelin Filomena Flora Iolanda Irene Iracema Josefina Judite Livia Luzia Margarida Marli Matilde Miriam Otavia Paloma Penelope Roseli Ruth Silmara Teresa Valesca Wilma Zilda Zulmira
Jose Joao Antonio Francisco Carlos Paulo Pedro Lucas Luiz Marcos Luis Gabriel Rafael Daniel Marcelo Bruno Eduardo Felipe Raimundo Rodrigo Manoel Mateus Andre Fernando Fabio Leonardo Gustavo Guilherme Leandro Tiago Anderson Ricardo Marcio Jorge Alexandre Roberto Ronaldo Diego Sergio Edson Henrique Luciano Thiago Vinicius Julio Elias Emanuel Vitor Victor Samuel Davi David Matheus Miguel Arthur Heitor Bernardo Nicolas Lorenzo Enzo Murilo Benicio Gael Theo Joaquim Isaac Dario Otavio Augusto Caio Cesar Claudio Cristiano Denis Douglas Eder Elton Emerson Eric Ernesto Everton Evandro Fabricio Flavio Frederico Geraldo Gilberto Gilmar Gerson Hamilton Hugo Igor Israel Ivan Jaime Jairo Jefferson Jeremias Jesse Jonas Jonathan Josue Juan Kleber Lauro Levi Lucio Moacir Nelson Nilson Norberto Odair Orlando Osvaldo Renato Robson Rogerio Rubens Saulo Sidnei Silvio Tadeu Valdir Valmir Wagner Walter Washington Wellington William Wilson Abel Adalberto Ademir Adilson Afonso Alan Alberto Alcides Aldo Alfredo Alisson Alvaro Amadeu Ailton Anselmo Ari Armando Arnaldo Artur Atila Benedito Benjamin Ciro Dimas Domingos Edgard Edmilson Edvaldo Eliseu Eraldo Euclides Eusebio Expedito Gilson Haroldo Humberto Icaro Inacio Ismael Italo Jacinto Jean Jeronimo Joel Josimar Juvenal Laercio Leonel Lourival Lucimar Mauricio Messias Milton Natan Noel Odilon Osmar Reginaldo Renan Rian Ruan Rui Sandro Sebastiao Tales Ubirajara Valdemar Valter Vicente Wesley Yago Yuri Zacarias`.trim().split(/\s+/)
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const nameSet = new Set(names.map(norm))
  assert.ok(nameSet.size >= 300)
  const prior = execFileSync('git', ['show', 'origin/main:src/lib/operator/privacy.ts'], { encoding: 'utf8' })
  const current = readFileSync('src/lib/operator/privacy.ts', 'utf8')
  const words = (s: string) => [...s.split('const ALLOWED_WORDS = new Set([')[1].split('])')[0].matchAll(/'([^']+)'/g)].map(m => m[1])
  const old = new Set(words(prior))
  for (const word of words(current).filter(w => !old.has(w))) assert.equal(nameSet.has(norm(word)), false, word)
})
