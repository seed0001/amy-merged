# Local explanations with Ollama

Set these values in `.env`, then restart Amy through the usual launcher:

```dotenv
AMY_LLM_ENABLED=true
AMY_LLM_URL=http://127.0.0.1:11434
AMY_LLM_MODEL=gemma4:12b
AMY_LLM_TIMEOUT=25
```

The model must already be installed. Amy does not download models or connect to cloud endpoints. Setting `AMY_LLM_ENABLED=false` restores the existing conversation path.

The LLM receives a bounded selection of current active claims, learned rules, rechecked conclusions, and the actual parser and reasoning results for the turn. It chooses explanation fragments and can propose deductions. Amy renders the fragments herself; a proposed deduction must be proved from the supplied facts and rules, with no conflicting evidence. The LLM has no tools or database writer. Its free-form commentary and its private thinking output are never spoken. Instructions alone cannot remove pretrained knowledge, so the output gate enforces this restriction in code.

For example, after teaching `If someone is furry, they are warm.` and `Pip is furry.`, ask `Is Pip warm?`. The answer can explain the actual fact and rule used. `How did you process that?` explains the last recorded turn for the current speaker.

If parsing fails, she explains how to express facts and rules and can offer checked wording. For `Regarding Luma, sparkly.`, she can suggest `Luma is sparkly.`. Suggestions are tested against the parser and a separate temporary memory, and are explicitly labeled as suggestions. They introduce no new content words, must preserve negation and modality, and are not learned automatically. Check the meaning and say the statement yourself to teach it.

A parseable question with missing evidence gets a request for the missing fact or rule, rather than a rewrite that invents it. The local explanation path disables automatic web gap-filling. Explicit search commands remain handled by the existing search feature.

Invalid model responses, unproved deductions, invented evidence IDs and unavailable Ollama all fall back to explanations assembled from the same recorded operations and evidence. Each reply's `llm` trace records validation status, evidence IDs and timing. Raw rejected model text is not logged as a reply or learned.

Offline checks: `python -m pytest tests/test_grounded_llm.py tests/test_reasoning_requests.py tests/test_connected_reasoning.py tests/test_thinking_integration.py -q`.
