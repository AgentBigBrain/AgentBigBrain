import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync('./runtime/ledgers.sqlite');

console.log('--- REJECTED MERGES ---');
const rejections = db.prepare('SELECT * FROM distiller_rejections LIMIT 5').all();
console.dir(rejections, { depth: null });

console.log('\n--- APPROVED MERGES (if applicable tracked in DB) ---');
try {
    const merges = db.prepare('SELECT * FROM distiller_merges LIMIT 5').all();
    console.dir(merges, { depth: null });
} catch (e) {
    console.log('No specific distiller_merges table found, checking execution receipts instead:');
}
