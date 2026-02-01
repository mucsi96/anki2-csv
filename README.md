# anki2-csv

Converts Anki `.anki2` SQLite databases to CSV files, one per deck.

Supports both legacy and modern (2.1.28+) Anki database schemas.

## Prerequisites

- Node.js 18+

## Install

```sh
npm install
```

## Usage

```
node anki-to-csv.js <anki2-file> [output-dir] [options]
```

### Arguments

| Argument     | Description                                    |
|--------------|------------------------------------------------|
| `anki2-file` | Path to the `.anki2` SQLite database file      |
| `output-dir` | Output directory for CSV files (default: `.`)   |

### Options

| Option       | Description                                              |
|--------------|----------------------------------------------------------|
| `--meta`     | Include metadata columns (card status, reviews, etc.)    |
| `--help, -h` | Show help message                                       |

## Examples

```sh
# Export to current directory (fields + tags only)
node anki-to-csv.js collection.anki2

# Export to a specific directory
node anki-to-csv.js ~/Anki2/User/collection.anki2 ./output

# Include metadata columns
node anki-to-csv.js collection.anki2 ./output --meta
```

## npm scripts

```sh
# Export using the default Anki path (WSL) to out/ folder
npm start
```

## Output format

By default, each deck is exported as a separate CSV with note field columns and a `tags` column.

With `--meta`, the following additional columns are prepended:

| Column           | Description                          |
|------------------|--------------------------------------|
| `note_id`        | Anki note ID                         |
| `card_id`        | Anki card ID                         |
| `card_ord`       | Card ordinal within the note         |
| `note_type`      | Note type (model) name               |
| `note_type_style`| Standard or cloze                    |
| `tags`           | Space-separated tags                 |
| `card_status`    | new / learning / review / relearning |
| `card_queue`     | Scheduling queue                     |
| `interval_days`  | Review interval in days              |
| `ease_factor`    | Ease multiplier                      |
| `reviews`        | Total review count                   |
| `lapses`         | Number of lapses                     |
| `due`            | Due value                            |
| `last_modified`  | Last modified timestamp (ISO 8601)   |

## Interactive workflow

The tool runs an interactive CLI that guides you through:

1. **Deck selection** – pick which deck to export
2. **Column selection** – choose which fields to include
3. **Filtering** – optionally filter rows by the starting letter of a chosen column
4. **Export format** – CSV or PDF

### German article handling

When filtering and sorting by starting letter, German articles at the beginning of a value are ignored. For example, "die Katze" is sorted and filtered under **K**, not **D**.

Ignored articles: `die`, `der`, `das`, `den`, `dem`, `ein`, `eine`, `einen`, `einem`, `einer`.

## Note on `.apkg` files

`.apkg` files are ZIP archives. Extract them first to get the `.anki2` database file inside.
