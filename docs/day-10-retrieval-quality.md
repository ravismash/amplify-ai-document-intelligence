# Day 10 Retrieval Quality

## Evaluation workflow

The server exposes `POST /api/search/evaluate`. Submit cases with the query and the document IDs expected to be relevant:

```json
{
  "cases": [
    {
      "query": "procurement risk",
      "expectedDocumentIds": ["doc_example_supplier"]
    },
    {
      "query": "approval governance",
      "expectedDocumentIds": ["doc_example_approval"]
    }
  ]
}
```

The response reports:

- `hitRate`: percentage of cases with an expected document in the top five results
- `meanReciprocalRank`: average reciprocal rank of the first expected result
- Per-case result order and hit status

The demo evaluation run for Day 10 returned a `1.0` hit rate and `1.0` mean reciprocal rank across two representative cases.

## Search behavior

- Search uses the indexed chunk vectors and cosine similarity.
- Results are ranked by descending relevance score.
- Search accepts an optional `documentIds` filter.
- Result limits are bounded between 1 and 20.
- Unindexed chunks are excluded from search.
