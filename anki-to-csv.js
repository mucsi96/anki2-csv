#!/usr/bin/env node

/**
 * Anki Interactive Exporter
 *
 * Reads an Anki SQLite database (.anki2 file) and guides the user through
 * an interactive export workflow: deck selection, column picking, filtering,
 * and export to CSV or PDF.
 *
 * Usage: node anki-to-csv.js <path-to-anki2-file>
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const FIELD_SEPARATOR = '\x1f';

// ── Utility functions ───────────────────────────────────────────────────

function decodeHtmlEntities(str) {
    return str
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(value) {
    if (value === null || value === undefined) return '';
    return decodeHtmlEntities(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function escapeCsvField(value) {
    const str = stripHtml(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/__+/g, '_')
        .substring(0, 100);
}

const CARD_TYPES = {
    0: 'new',
    1: 'learning',
    2: 'review',
    3: 'relearning'
};

const QUEUE_TYPES = {
    '-3': 'user_buried',
    '-2': 'sched_buried',
    '-1': 'suspended',
    '0': 'new',
    '1': 'learning',
    '2': 'review',
    '3': 'day_learning',
    '4': 'preview'
};

const META_COLUMNS = [
    'note_id',
    'card_id',
    'card_ord',
    'note_type',
    'note_type_style',
    'card_status',
    'card_queue',
    'interval_days',
    'ease_factor',
    'reviews',
    'lapses',
    'due',
    'last_modified'
];

// ── Database helpers ────────────────────────────────────────────────────

function queryAll(db, sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
}

function queryOne(db, sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    let result = null;
    if (stmt.step()) result = stmt.getAsObject();
    stmt.free();
    return result;
}

// ── AnkiDatabase ────────────────────────────────────────────────────────

class AnkiDatabase {
    constructor(anki2Path) {
        this.anki2Path = anki2Path;
        this.db = null;
        this.models = {};
        this.decks = {};
    }

    async open() {
        if (!fs.existsSync(this.anki2Path)) {
            throw new Error(`File not found: ${this.anki2Path}`);
        }
        const SQL = await initSqlJs();
        const fileBuffer = fs.readFileSync(this.anki2Path);
        this.db = new SQL.Database(fileBuffer);
        this._loadMetadata();
    }

    _loadMetadata() {
        const col = queryOne(this.db, 'SELECT models, decks FROM col');
        if (!col) throw new Error('No collection data found in database');

        const hasLegacy =
            col.models && col.models !== '{}' && col.models !== '' &&
            col.decks && col.decks !== '{}' && col.decks !== '';

        if (hasLegacy) {
            this.models = JSON.parse(col.models);
            this.decks = JSON.parse(col.decks);
        } else {
            this._loadModernSchema();
        }
    }

    _loadModernSchema() {
        this.models = {};
        for (const nt of queryAll(this.db, 'SELECT id, name FROM notetypes')) {
            const fields = queryAll(
                this.db,
                'SELECT ord, name FROM FIELDS WHERE ntid = ? ORDER BY ord',
                [nt.id]
            );
            const templates = queryAll(
                this.db,
                'SELECT ord, name FROM templates WHERE ntid = ? ORDER BY ord',
                [nt.id]
            );
            this.models[nt.id] = {
                name: nt.name,
                flds: fields.map(f => ({ ord: f.ord, name: f.name })),
                tmpls: templates.map(t => ({ name: t.name, ord: t.ord })),
                type: 0
            };
        }
        this.decks = {};
        for (const d of queryAll(this.db, 'SELECT id, name FROM decks')) {
            this.decks[d.id] = { name: d.name };
        }
    }

    getFieldNames(modelId) {
        const model = this.models[modelId];
        if (!model) return [];
        return model.flds.sort((a, b) => a.ord - b.ord).map(f => f.name);
    }

    getModelName(modelId) {
        return this.models[modelId]?.name || `Unknown_${modelId}`;
    }

    getModelType(modelId) {
        const model = this.models[modelId];
        return model ? (model.type === 1 ? 'cloze' : 'standard') : 'unknown';
    }

    getDeckName(deckId) {
        return this.decks[deckId]?.name || `Unknown_${deckId}`;
    }

    getDeckStats() {
        const rows = queryAll(this.db, `
            SELECT c.did AS deck_id,
                   COUNT(DISTINCT n.id) AS note_count,
                   COUNT(c.id)          AS card_count
            FROM cards c
            JOIN notes n ON c.nid = n.id
            GROUP BY c.did
        `);
        return rows.map(r => ({
            id: r.deck_id,
            name: this.getDeckName(r.deck_id),
            noteCount: r.note_count,
            cardCount: r.card_count
        }));
    }

    getNotesForDeck(deckId) {
        return queryAll(this.db, `
            SELECT DISTINCT n.id  AS note_id,
                            n.mid AS model_id,
                            n.flds AS fields,
                            n.tags AS tags
            FROM notes n
            JOIN cards c ON c.nid = n.id
            WHERE c.did = ?
        `, [deckId]);
    }

    getCardsForDeck(deckId) {
        return queryAll(this.db, `
            SELECT c.id     AS card_id,
                   c.nid    AS note_id,
                   c.ord    AS card_ord,
                   c.type   AS card_type,
                   c.queue  AS card_queue,
                   c.due    AS card_due,
                   c.ivl    AS card_interval,
                   c.factor AS card_factor,
                   c.reps   AS card_reps,
                   c.lapses AS card_lapses,
                   c.mod    AS card_mod,
                   n.mid    AS model_id,
                   n.flds   AS fields,
                   n.tags   AS tags
            FROM cards c
            JOIN notes n ON c.nid = n.id
            WHERE c.did = ?
            ORDER BY n.mid, c.ord
        `, [deckId]);
    }

    close() {
        if (this.db) this.db.close();
    }
}

// ── Data building ───────────────────────────────────────────────────────

function buildRows(ankiDb, rawData, includeMeta, selectedColumns) {
    const rows = [];

    for (const item of rawData) {
        const fieldNames = ankiDb.getFieldNames(item.model_id);
        const fieldValues = item.fields.split(FIELD_SEPARATOR);
        const parsedFields = {};
        fieldNames.forEach((name, i) => {
            parsedFields[name] = stripHtml(fieldValues[i] || '');
        });

        const row = {};

        // Metadata columns (only when meta mode is on)
        if (includeMeta) {
            row['note_id'] = item.note_id;
            row['card_id'] = item.card_id;
            row['card_ord'] = item.card_ord;
            row['note_type'] = ankiDb.getModelName(item.model_id);
            row['note_type_style'] = ankiDb.getModelType(item.model_id);
            row['card_status'] = CARD_TYPES[item.card_type] || String(item.card_type);
            row['card_queue'] = QUEUE_TYPES[item.card_queue] || String(item.card_queue);
            row['interval_days'] = item.card_interval;
            row['ease_factor'] = (item.card_factor / 1000).toFixed(2);
            row['reviews'] = item.card_reps;
            row['lapses'] = item.card_lapses;
            row['due'] = item.card_due;
            row['last_modified'] = new Date(item.card_mod * 1000).toISOString();
        }

        // Field columns
        for (const name of fieldNames) {
            row[name] = parsedFields[name];
        }

        // Tags (always available)
        row['tags'] = (item.tags || '').trim();

        // Keep only the user-selected columns, in selection order
        const filtered = {};
        for (const col of selectedColumns) {
            filtered[col] = row[col] !== undefined ? String(row[col]) : '';
        }
        rows.push(filtered);
    }

    return rows;
}

// ── CSV export ──────────────────────────────────────────────────────────

function exportToCsv(outputPath, columns, rows) {
    const lines = [];
    lines.push(columns.map(escapeCsvField).join(','));
    for (const row of rows) {
        lines.push(columns.map(col => escapeCsvField(row[col])).join(','));
    }
    fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
}

// ── PDF export ──────────────────────────────────────────────────────────

function findUnicodeFont() {
    const candidates = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function findUnicodeFontBold() {
    const candidates = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function exportToPdf(outputPath, columns, rows, title) {
    let PDFDocument;
    try {
        PDFDocument = require('pdfkit');
    } catch {
        throw new Error('pdfkit is required for PDF export. Run: npm install');
    }

    const fontRegular = findUnicodeFont();
    const fontBold = findUnicodeFontBold();

    const doc = new PDFDocument({ layout: 'landscape', margin: 30, size: 'A4' });

    if (fontRegular) doc.registerFont('Regular', fontRegular);
    if (fontBold) doc.registerFont('Bold', fontBold);

    const regularFont = fontRegular ? 'Regular' : 'Helvetica';
    const boldFont = fontBold ? 'Bold' : 'Helvetica-Bold';

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const pageWidth = doc.page.width - 60;
    const pageHeight = doc.page.height - 60;
    const colCount = columns.length;
    const colWidth = Math.floor(pageWidth / colCount);
    const tableWidth = colWidth * colCount;
    const fontSize = colCount > 10 ? 5 : colCount > 7 ? 6 : colCount > 4 ? 7 : 8;
    const rowHeight = fontSize + 6;
    const headerHeight = fontSize + 8;

    // Title
    doc.fontSize(14).font(boldFont)
        .text(title, 30, 30, { align: 'center', width: pageWidth });
    doc.moveDown(0.3);
    doc.fontSize(8).font(regularFont).fillColor('#666666')
        .text(`${rows.length} rows | ${new Date().toISOString().slice(0, 10)}`, {
            align: 'center', width: pageWidth
        });
    doc.moveDown(0.5);

    let y = doc.y;

    function drawHeader() {
        doc.rect(30, y, tableWidth, headerHeight).fill('#4472C4');
        doc.font(boldFont).fontSize(fontSize).fillColor('white');
        columns.forEach((col, i) => {
            doc.text(col, 33 + i * colWidth, y + 3, {
                width: colWidth - 6, ellipsis: true, lineBreak: false
            });
        });
        y += headerHeight;
        doc.fillColor('black');
    }

    function checkPage() {
        if (y + rowHeight > pageHeight + 30) {
            doc.addPage();
            y = 30;
            drawHeader();
        }
    }

    drawHeader();

    doc.font(regularFont).fontSize(fontSize);
    rows.forEach((row, rowIdx) => {
        checkPage();

        if (rowIdx % 2 === 0) {
            doc.save();
            doc.rect(30, y, tableWidth, rowHeight).fill('#F2F2F2');
            doc.restore();
            doc.fillColor('black');
        }

        columns.forEach((col, i) => {
            const val = String(row[col] || '');
            doc.text(val, 33 + i * colWidth, y + 2, {
                width: colWidth - 6, ellipsis: true, lineBreak: false
            });
        });
        y += rowHeight;
    });

    doc.end();

    return new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
}

// ── Main interactive flow ───────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`
Anki Interactive Exporter
=========================

Usage: node anki-to-csv.js <anki2-file> [output-dir]

Opens an Anki database and guides you through an interactive export:
  1. Select a deck
  2. Choose whether to include metadata columns
  3. Pick individual columns
  4. Export all rows or filter by prefix
  5. Choose export format (CSV or PDF)
`);
        process.exit(0);
    }

    const { select, checkbox, confirm, input } = await import('@inquirer/prompts');
    const anki2Path = args[0];
    const outputDir = args[1] || '.';

    console.log('Anki Interactive Exporter');
    console.log('========================\n');

    const ankiDb = new AnkiDatabase(anki2Path);

    try {
        // ── Load database ───────────────────────────────────────────
        console.log(`Loading: ${anki2Path}`);
        await ankiDb.open();

        const modelCount = Object.keys(ankiDb.models).length;
        const deckCount = Object.keys(ankiDb.decks).length;
        console.log(`Found ${modelCount} note type(s), ${deckCount} deck(s)\n`);

        // ── Step 1: Select a deck ───────────────────────────────────
        const deckStats = ankiDb.getDeckStats();
        if (deckStats.length === 0) {
            console.log('No decks with cards found in this database.');
            return;
        }

        const selectedDeck = await select({
            message: 'Select a deck:',
            choices: deckStats.map(d => ({
                name: `${d.name}  (${d.noteCount} notes, ${d.cardCount} cards)`,
                value: d
            }))
        });

        // ── Step 2: Include metadata? ───────────────────────────────
        const includeMeta = await confirm({
            message: 'Include metadata columns?',
            default: false
        });

        // ── Fetch raw data from DB ──────────────────────────────────
        const rawData = includeMeta
            ? ankiDb.getCardsForDeck(selectedDeck.id)
            : ankiDb.getNotesForDeck(selectedDeck.id);

        if (rawData.length === 0) {
            console.log('No data found for this deck.');
            return;
        }

        // Collect field column names (union across note types)
        const fieldNamesSet = new Set();
        for (const item of rawData) {
            for (const f of ankiDb.getFieldNames(item.model_id)) {
                fieldNamesSet.add(f);
            }
        }
        const fieldColumns = Array.from(fieldNamesSet);

        // Build the full list of available columns
        const allAvailable = [
            ...(includeMeta ? META_COLUMNS : []),
            ...fieldColumns,
            'tags'
        ];

        // ── Step 3: Pick columns ────────────────────────────────────
        const selectedColumns = await checkbox({
            message: 'Select columns to include:',
            choices: allAvailable.map(col => ({
                name: col,
                value: col,
                checked: true
            })),
            required: true
        });

        // ── Step 4: Export mode ─────────────────────────────────────
        const exportMode = await select({
            message: 'Export rows:',
            choices: [
                { name: 'All rows', value: 'all' },
                { name: 'Filter by prefix (e.g. A, die, das)', value: 'filter' }
            ]
        });

        let filterColumn = null;
        let filterPrefix = null;

        if (exportMode === 'filter') {
            const filterableColumns = selectedColumns.filter(
                c => !META_COLUMNS.includes(c)
            );

            if (filterableColumns.length === 0) {
                console.log('No field columns selected to filter on. Exporting all rows.');
            } else {
                filterColumn = await select({
                    message: 'Which column to filter and sort by?',
                    choices: filterableColumns.map(col => ({
                        name: col,
                        value: col
                    }))
                });

                const prefixRaw = await input({
                    message: 'Starts with:',
                    validate: val =>
                        val.trim().length > 0 || 'Enter at least one character'
                });
                filterPrefix = prefixRaw.trim().toLowerCase();
            }
        }

        // ── Step 5: Export format ───────────────────────────────────
        const format = await select({
            message: 'Export format:',
            choices: [
                { name: 'CSV', value: 'csv' },
                { name: 'PDF', value: 'pdf' }
            ]
        });

        // ── Build, filter, sort ─────────────────────────────────────
        let rows = buildRows(ankiDb, rawData, includeMeta, selectedColumns);

        if (filterColumn && filterPrefix) {
            rows = rows.filter(row => {
                const val = String(row[filterColumn] || '').trim().toLowerCase();
                return val.startsWith(filterPrefix);
            });
        }

        if (filterColumn) {
            rows.sort((a, b) => {
                const va = String(a[filterColumn] || '').toLowerCase();
                const vb = String(b[filterColumn] || '').toLowerCase();
                return va.localeCompare(vb);
            });
        }

        if (rows.length === 0) {
            console.log('\nNo rows match the filter. Nothing to export.');
            return;
        }

        // ── Generate output ─────────────────────────────────────────
        const resolvedDir = path.resolve(outputDir);
        if (!fs.existsSync(resolvedDir)) {
            fs.mkdirSync(resolvedDir, { recursive: true });
        }
        const safeDeck = sanitizeFilename(selectedDeck.name);
        const suffix = filterPrefix ? `_${sanitizeFilename(filterPrefix)}` : '';
        const outputPath = path.join(resolvedDir, `${safeDeck}${suffix}.${format}`);

        console.log(`\nExporting ${rows.length} rows...`);

        if (format === 'csv') {
            exportToCsv(outputPath, selectedColumns, rows);
        } else {
            const title = `${selectedDeck.name}${filterPrefix ? ` - "${filterPrefix}"` : ''}`;
            await exportToPdf(outputPath, selectedColumns, rows, title);
        }

        console.log(`Done: ${outputPath}`);

    } catch (error) {
        console.error(`\nError: ${error.message}`);
        process.exit(1);
    } finally {
        ankiDb.close();
    }
}

// ── Entry point ─────────────────────────────────────────────────────────

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { AnkiDatabase };
