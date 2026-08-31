/**
 * Offline parser check: every paste dialect of a permit must parse to the
 * same legs as its curated fixture. Runs without network — `npm run test:parse`.
 *
 * fixtures/paste/ holds real-world paste shapes (currently the cell-split
 * form that macOS PDF viewers produce, where each table cell arrives on its
 * own line). A client pasted exactly that and the route became verb fragments.
 */
import { readFileSync } from 'fs'
import { parseInput } from '../src/engine/parse'

let failures = 0
for (const n of [1, 2, 3, 4, 5]) {
  const ref = parseInput(readFileSync(`fixtures/actual/tx${n}.txt`, 'utf8'))
  const alt = parseInput(readFileSync(`fixtures/paste/tx${n}-cellsplit.txt`, 'utf8'))
  const sig = (p: typeof ref) => `${p.legs.length} legs, ${p.claimedTotalMiles?.toFixed(1)} mi`
  const ok = alt.legs.length === ref.legs.length && alt.claimedTotalMiles?.toFixed(1) === ref.claimedTotalMiles?.toFixed(1)
  console.log(`tx${n}: fixture ${sig(ref)} | cell-split ${sig(alt)} ${ok ? '✔' : '✘'}`)
  if (!ok) failures++
  const junk = alt.legs.filter((l) => /^(take|turn|continue|merge|miles$|est\.|distance$)/i.test(l.label))
  if (junk.length) { console.log(`  ✘ junk legs: ${junk.map((l) => l.label).join(' | ')}`); failures++ }
}
if (failures) { console.error(`${failures} parse check(s) failed`); process.exit(1) }
console.log('all paste dialects parse identically')
