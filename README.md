# CONMERGE SchemaLogix Prototype

This is the AI Project prototype for CONMERGE. It implements a SchemaLogix-style schema matching flow using TF-IDF vectorization, cosine similarity, bootstrapped training labels, logistic regression classification, threshold-based match decisions, and user validation feedback.

## Run

Open `index.html` in a browser.

Optional local server:

```powershell
cd C:\Users\abiga\Documents\Codex\2026-06-03\this-is-our-ai-project-the\outputs\conmerge-prototype
node server.cjs
```

Then visit:

```text
http://localhost:8000
```

## Included SchemaLogix Behavior

- User-uploaded CSV dataset pairs.
- Schema description vectorization using column names, inferred types, and sample values.
- TF-IDF-style vectors and cosine similarity.
- Automatically bootstrapped training labels.
- Lightweight logistic regression classifier.
- Default match probability threshold of `0.70`.
- User approval/rejection feedback for candidate correspondences.
- Dashboard, dataset preview, results table, settings, logs, and merged schema preview.

## Excluded Thesis Features

- No CNN.
- No BERT embeddings.
- No conflict detection and resolution.
