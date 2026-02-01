#!/usr/bin/env node

/**
 * Anki .anki2 to CSV Converter
 * 
 * Reads an Anki SQLite database (.anki2 file) and creates separate CSV files
 * for each deck, analyzing card types to determine appropriate columns.
 * 
 * Usage: node anki-to-csv.js <path-to-anki2-file> [output-directory]
 * 
 * Database Structure (from AnkiDroid wiki):
 * - col: Collection metadata with models/decks as JSON
 * - notes: Note content with fields separated by 0x1f
 * - cards: Card instances linked to notes and decks
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// Field separator used in Anki notes.flds
const FIELD_SEPARATOR = '\x1f';

/**
 * Sanitizes a string for CSV output
 * - Escapes double quotes by doubling them
 * - Wraps in quotes if contains comma, newline, or quote
 */
function escapeCsvField(value) {
    if (value === null || value === undefined) {
        return '';
    }
    const str = String(value);
    // Remove HTML tags for cleaner CSV output (optional)
    const cleaned = str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    
    if (cleaned.includes(',') || cleaned.includes('"') || cleaned.includes('\n') || cleaned.includes('\r')) {
        return '"' + cleaned.replace(/"/g, '""') + '"';
    }
    return cleaned;
}

/**
 * Sanitizes filename by removing/replacing invalid characters
 */
function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/__+/g, '_')
        .substring(0, 100); // Limit length
}

/**
 * Card type mapping
 */
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

/**
 * Helper to execute SQL and get all results as array of objects
 */
function queryAll(db, sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
        stmt.bind(params);
    }
    const results = [];
    while (stmt.step()) {
        const row = stmt.getAsObject();
        results.push(row);
    }
    stmt.free();
    return results;
}

/**
 * Helper to execute SQL and get single result
 */
function queryOne(db, sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
        stmt.bind(params);
    }
    let result = null;
    if (stmt.step()) {
        result = stmt.getAsObject();
    }
    stmt.free();
    return result;
}

/**
 * Main converter class
 */
class AnkiToCsvConverter {
    constructor(anki2Path, outputDir) {
        this.anki2Path = anki2Path;
        this.outputDir = outputDir || path.dirname(anki2Path);
        this.db = null;
        this.models = {};
        this.decks = {};
    }

    /**
     * Opens the database and loads collection metadata
     */
    async open() {
        console.log(`Opening database: ${this.anki2Path}`);
        
        if (!fs.existsSync(this.anki2Path)) {
            throw new Error(`File not found: ${this.anki2Path}`);
        }

        // Initialize sql.js
        const SQL = await initSqlJs();
        
        // Read database file
        const fileBuffer = fs.readFileSync(this.anki2Path);
        this.db = new SQL.Database(fileBuffer);
        
        // Load collection metadata
        const col = queryOne(this.db, 'SELECT models, decks FROM col');
        
        if (!col) {
            throw new Error('No collection data found in database');
        }

        // Parse models and decks JSON
        this.models = JSON.parse(col.models);
        this.decks = JSON.parse(col.decks);

        console.log(`Found ${Object.keys(this.models).length} note type(s)`);
        console.log(`Found ${Object.keys(this.decks).length} deck(s)`);
    }

    /**
     * Gets field names for a model (note type)
     */
    getFieldNames(modelId) {
        const model = this.models[modelId];
        if (!model) {
            console.warn(`Model ${modelId} not found`);
            return [];
        }
        
        // Sort fields by ordinal and extract names
        return model.flds
            .sort((a, b) => a.ord - b.ord)
            .map(f => f.name);
    }

    /**
     * Gets model name
     */
    getModelName(modelId) {
        const model = this.models[modelId];
        return model ? model.name : `Unknown_${modelId}`;
    }

    /**
     * Gets model type (0=standard, 1=cloze)
     */
    getModelType(modelId) {
        const model = this.models[modelId];
        return model ? (model.type === 1 ? 'cloze' : 'standard') : 'unknown';
    }

    /**
     * Gets deck name (handles nested decks with :: separator)
     */
    getDeckName(deckId) {
        const deck = this.decks[deckId];
        return deck ? deck.name : `Unknown_${deckId}`;
    }

    /**
     * Parses note fields into an object using model field definitions
     */
    parseNoteFields(flds, modelId) {
        const fieldNames = this.getFieldNames(modelId);
        const fieldValues = flds.split(FIELD_SEPARATOR);
        
        const result = {};
        fieldNames.forEach((name, index) => {
            result[name] = fieldValues[index] || '';
        });
        
        return result;
    }

    /**
     * Gets all cards grouped by deck
     */
    getCardsByDeck() {
        const query = `
            SELECT 
                c.id as card_id,
                c.nid as note_id,
                c.did as deck_id,
                c.ord as card_ord,
                c.type as card_type,
                c.queue as card_queue,
                c.due as card_due,
                c.ivl as card_interval,
                c.factor as card_factor,
                c.reps as card_reps,
                c.lapses as card_lapses,
                c.mod as card_mod,
                n.mid as model_id,
                n.flds as fields,
                n.tags as tags,
                n.mod as note_mod
            FROM cards c
            JOIN notes n ON c.nid = n.id
            ORDER BY c.did, n.mid, c.ord
        `;

        const rows = queryAll(this.db, query);
        
        // Group by deck
        const byDeck = {};
        for (const row of rows) {
            const deckId = row.deck_id;
            if (!byDeck[deckId]) {
                byDeck[deckId] = [];
            }
            byDeck[deckId].push(row);
        }

        return byDeck;
    }

    /**
     * Analyzes what columns are needed for a set of cards
     */
    analyzeColumns(cards) {
        const columns = new Set();
        const fieldsByModel = {};

        for (const card of cards) {
            const modelId = card.model_id;
            
            if (!fieldsByModel[modelId]) {
                fieldsByModel[modelId] = this.getFieldNames(modelId);
            }
            
            // Add all fields from this model
            fieldsByModel[modelId].forEach(f => columns.add(f));
        }

        return {
            fieldColumns: Array.from(columns),
            modelInfo: fieldsByModel
        };
    }

    /**
     * Exports cards to CSV for a single deck
     */
    exportDeckToCsv(deckId, cards) {
        const deckName = this.getDeckName(deckId);
        const safeName = sanitizeFilename(deckName);
        const outputPath = path.join(this.outputDir, `${safeName}.csv`);

        console.log(`\nExporting deck: "${deckName}" (${cards.length} cards)`);

        // Analyze what columns we need
        const { fieldColumns, modelInfo } = this.analyzeColumns(cards);

        // Define metadata columns
        const metaColumns = [
            'note_id',
            'card_id', 
            'card_ord',
            'note_type',
            'note_type_style',
            'tags',
            'card_status',
            'card_queue',
            'interval_days',
            'ease_factor',
            'reviews',
            'lapses',
            'due',
            'last_modified'
        ];

        // Combine all columns
        const allColumns = [...metaColumns, ...fieldColumns];

        // Build CSV content
        const lines = [];
        
        // Header row
        lines.push(allColumns.map(escapeCsvField).join(','));

        // Data rows
        for (const card of cards) {
            const parsedFields = this.parseNoteFields(card.fields, card.model_id);
            const modelName = this.getModelName(card.model_id);
            const modelType = this.getModelType(card.model_id);

            const row = [
                // Metadata
                card.note_id,
                card.card_id,
                card.card_ord,
                modelName,
                modelType,
                (card.tags || '').trim(),
                CARD_TYPES[card.card_type] || card.card_type,
                QUEUE_TYPES[card.card_queue] || card.card_queue,
                card.card_interval,
                (card.card_factor / 1000).toFixed(2), // Convert permille to multiplier
                card.card_reps,
                card.card_lapses,
                card.card_due,
                new Date(card.card_mod * 1000).toISOString()
            ];

            // Add field values (in order of fieldColumns)
            for (const fieldName of fieldColumns) {
                row.push(parsedFields[fieldName] || '');
            }

            lines.push(row.map(escapeCsvField).join(','));
        }

        // Write file
        fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
        console.log(`  -> Saved: ${outputPath}`);
        console.log(`  -> Columns: ${allColumns.length} (${metaColumns.length} meta + ${fieldColumns.length} fields)`);
        console.log(`  -> Fields: ${fieldColumns.join(', ')}`);

        return {
            path: outputPath,
            deckName,
            cardCount: cards.length,
            columns: allColumns
        };
    }

    /**
     * Generates a summary report
     */
    generateSummary(results) {
        const summaryPath = path.join(this.outputDir, '_export_summary.txt');
        
        const lines = [
            '='.repeat(60),
            'ANKI TO CSV EXPORT SUMMARY',
            '='.repeat(60),
            '',
            `Source: ${this.anki2Path}`,
            `Export Date: ${new Date().toISOString()}`,
            '',
            '-'.repeat(60),
            'NOTE TYPES (Models)',
            '-'.repeat(60),
            ''
        ];

        for (const [id, model] of Object.entries(this.models)) {
            const fields = model.flds.sort((a, b) => a.ord - b.ord).map(f => f.name);
            const type = model.type === 1 ? 'Cloze' : 'Standard';
            lines.push(`[${model.name}] (${type})`);
            lines.push(`  ID: ${id}`);
            lines.push(`  Fields: ${fields.join(', ')}`);
            lines.push(`  Templates: ${model.tmpls.map(t => t.name).join(', ')}`);
            lines.push('');
        }

        lines.push('-'.repeat(60));
        lines.push('EXPORTED DECKS');
        lines.push('-'.repeat(60));
        lines.push('');

        for (const result of results) {
            lines.push(`[${result.deckName}]`);
            lines.push(`  Cards: ${result.cardCount}`);
            lines.push(`  File: ${path.basename(result.path)}`);
            lines.push('');
        }

        lines.push('='.repeat(60));

        fs.writeFileSync(summaryPath, lines.join('\n'), 'utf8');
        console.log(`\nSummary saved: ${summaryPath}`);
    }

    /**
     * Main conversion process
     */
    async convert() {
        try {
            await this.open();

            // Ensure output directory exists
            if (!fs.existsSync(this.outputDir)) {
                fs.mkdirSync(this.outputDir, { recursive: true });
            }

            // Get all cards grouped by deck
            const cardsByDeck = this.getCardsByDeck();

            if (Object.keys(cardsByDeck).length === 0) {
                console.log('No cards found in database');
                return;
            }

            // Export each deck
            const results = [];
            for (const [deckId, cards] of Object.entries(cardsByDeck)) {
                const result = this.exportDeckToCsv(deckId, cards);
                results.push(result);
            }

            // Generate summary
            this.generateSummary(results);

            console.log('\n' + '='.repeat(60));
            console.log(`Export complete! ${results.length} deck(s) exported.`);
            console.log('='.repeat(60));

        } finally {
            if (this.db) {
                this.db.close();
            }
        }
    }
}

/**
 * Alternative simple export - just notes with fields, grouped by deck
 */
class SimpleAnkiExporter {
    constructor(anki2Path, outputDir) {
        this.anki2Path = anki2Path;
        this.outputDir = outputDir || path.dirname(anki2Path);
        this.db = null;
    }

    async open() {
        const SQL = await initSqlJs();
        const fileBuffer = fs.readFileSync(this.anki2Path);
        this.db = new SQL.Database(fileBuffer);
    }

    /**
     * Simple export: one CSV per deck with just the note fields
     */
    async exportSimple() {
        await this.open();

        try {
            // Get collection metadata
            const col = queryOne(this.db, 'SELECT models, decks FROM col');
            const models = JSON.parse(col.models);
            const decks = JSON.parse(col.decks);

            // Get unique deck IDs from cards
            const deckRows = queryAll(this.db, 'SELECT DISTINCT did FROM cards');
            const deckIds = deckRows.map(r => r.did);

            console.log(`Found ${deckIds.length} deck(s) with cards\n`);

            for (const deckId of deckIds) {
                const deckName = decks[deckId]?.name || `Deck_${deckId}`;
                
                // Get all notes in this deck with their model info
                const notes = queryAll(this.db, `
                    SELECT DISTINCT n.id, n.mid, n.flds, n.tags
                    FROM notes n
                    JOIN cards c ON c.nid = n.id
                    WHERE c.did = ?
                `, [deckId]);

                if (notes.length === 0) continue;

                // Group notes by model to handle different field structures
                const notesByModel = {};
                for (const note of notes) {
                    if (!notesByModel[note.mid]) {
                        notesByModel[note.mid] = [];
                    }
                    notesByModel[note.mid].push(note);
                }

                // Export each model's notes to a separate file within the deck
                for (const [modelId, modelNotes] of Object.entries(notesByModel)) {
                    const model = models[modelId];
                    const modelName = model?.name || `Model_${modelId}`;
                    const fieldNames = model?.flds?.sort((a, b) => a.ord - b.ord).map(f => f.name) || [];

                    const safeDeckName = sanitizeFilename(deckName);
                    const safeModelName = sanitizeFilename(modelName);
                    const filename = Object.keys(notesByModel).length > 1 
                        ? `${safeDeckName}_${safeModelName}.csv`
                        : `${safeDeckName}.csv`;
                    
                    const outputPath = path.join(this.outputDir, filename);

                    // Build CSV
                    const lines = [];
                    
                    // Header: fields + tags
                    const header = [...fieldNames, 'tags'];
                    lines.push(header.map(escapeCsvField).join(','));

                    // Data rows
                    for (const note of modelNotes) {
                        const fieldValues = note.flds.split(FIELD_SEPARATOR);
                        const row = [...fieldValues.slice(0, fieldNames.length), (note.tags || '').trim()];
                        lines.push(row.map(escapeCsvField).join(','));
                    }

                    fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
                    console.log(`Exported: ${filename}`);
                    console.log(`  Deck: ${deckName}`);
                    console.log(`  Note Type: ${modelName}`);
                    console.log(`  Notes: ${modelNotes.length}`);
                    console.log(`  Fields: ${fieldNames.join(', ')}\n`);
                }
            }

        } finally {
            this.db.close();
        }
    }
}

// CLI Interface
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`
Anki .anki2 to CSV Converter
============================

Reads an Anki SQLite database and creates separate CSV files for each deck.

Usage:
  node anki-to-csv.js <anki2-file> [output-dir] [options]

Arguments:
  anki2-file    Path to the .anki2 SQLite database file
  output-dir    Output directory for CSV files (default: same as input)

Options:
  --simple      Simple export (just fields and tags, no metadata)
  --help, -h    Show this help message

Examples:
  node anki-to-csv.js collection.anki2
  node anki-to-csv.js ~/Anki2/User/collection.anki2 ./output
  node anki-to-csv.js deck.anki2 --simple

Note: For .apkg files, first extract them (they're ZIP files) to get the
      .anki2 database file inside.
`);
        process.exit(0);
    }

    const anki2Path = args[0];
    const outputDir = args.find(a => !a.startsWith('--')) !== args[0] 
        ? args.find((a, i) => i > 0 && !a.startsWith('--'))
        : path.dirname(anki2Path);
    const simpleMode = args.includes('--simple');

    console.log('Anki to CSV Converter');
    console.log('=====================\n');

    try {
        if (simpleMode) {
            console.log('Mode: Simple (fields + tags only)\n');
            const exporter = new SimpleAnkiExporter(anki2Path, outputDir);
            await exporter.exportSimple();
        } else {
            console.log('Mode: Full (with metadata)\n');
            const converter = new AnkiToCsvConverter(anki2Path, outputDir);
            await converter.convert();
        }
    } catch (error) {
        console.error(`\nError: ${error.message}`);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

// Export for use as module
module.exports = { AnkiToCsvConverter, SimpleAnkiExporter };
