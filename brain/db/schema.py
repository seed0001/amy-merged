"""Ordered SQL migrations. Append new entries; never edit applied ones."""

MIGRATIONS: list[str] = [
    """
    CREATE TABLE lexemes(
        id INTEGER PRIMARY KEY,
        lemma TEXT NOT NULL,
        pos TEXT NOT NULL,
        UNIQUE(lemma, pos)
    );
    CREATE TABLE inflections(
        id INTEGER PRIMARY KEY,
        lexeme_id INTEGER NOT NULL REFERENCES lexemes(id),
        form TEXT NOT NULL,
        features TEXT NOT NULL DEFAULT '',
        UNIQUE(lexeme_id, form)
    );
    CREATE TABLE concepts(
        id INTEGER PRIMARY KEY,
        lemma TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE entities(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        proper INTEGER NOT NULL,
        kind_concept_id INTEGER REFERENCES concepts(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE aliases(
        id INTEGER PRIMARY KEY,
        entity_id INTEGER NOT NULL REFERENCES entities(id),
        alias TEXT NOT NULL UNIQUE COLLATE NOCASE
    );
    CREATE TABLE utterances(
        id INTEGER PRIMARY KEY,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE assertions(
        id INTEGER PRIMARY KEY,
        subj_type TEXT NOT NULL CHECK(subj_type IN ('e', 'c')),
        subj_id INTEGER NOT NULL,
        predicate TEXT NOT NULL,
        obj_type TEXT NOT NULL CHECK(obj_type IN ('e', 'c')),
        obj_id INTEGER NOT NULL,
        polarity INTEGER NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        temporal_scope TEXT,
        source_utterance_id INTEGER REFERENCES utterances(id),
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX ix_assertions_subj ON assertions(predicate, subj_type, subj_id, status);
    CREATE INDEX ix_assertions_obj ON assertions(predicate, obj_type, obj_id, status);
    CREATE TABLE rules(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL
    );
    CREATE TABLE dialogue_turns(
        id INTEGER PRIMARY KEY,
        utterance_id INTEGER REFERENCES utterances(id),
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE questions(
        id INTEGER PRIMARY KEY,
        utterance_id INTEGER REFERENCES utterances(id),
        frame_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE inference_traces(
        id INTEGER PRIMARY KEY,
        utterance_id INTEGER REFERENCES utterances(id),
        status TEXT,
        trace_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE corrections(
        id INTEGER PRIMARY KEY,
        assertion_id INTEGER REFERENCES assertions(id),
        utterance_id INTEGER REFERENCES utterances(id),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    """,
    """
    CREATE TABLE assertion_args(
        id INTEGER PRIMARY KEY,
        assertion_id INTEGER NOT NULL REFERENCES assertions(id),
        role TEXT NOT NULL,
        value_type TEXT NOT NULL CHECK(value_type IN ('e', 'c', 'lit')),
        value_id INTEGER,
        literal TEXT
    );
    CREATE INDEX ix_assertion_args ON assertion_args(assertion_id);
    UPDATE assertions SET predicate = 'rel:own' WHERE predicate IN ('owns', 'owns_kind');
    """,
    """
    CREATE TABLE learned_rules(
        id INTEGER PRIMARY KEY,
        conditions_json TEXT NOT NULL,
        conclusions_json TEXT NOT NULL,
        variable_json TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        source_utterance_id INTEGER REFERENCES utterances(id),
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE corrections ADD COLUMN rule_id INTEGER REFERENCES learned_rules(id);
    """,
    """
    CREATE TABLE self_state(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    """,
    """
    CREATE TABLE self_state_log(
        id INTEGER PRIMARY KEY,
        ts REAL NOT NULL,
        snapshot_json TEXT NOT NULL
    );
    CREATE INDEX ix_self_state_log_ts ON self_state_log(ts);
    """,
    """
    CREATE TABLE emotion_events(
        id INTEGER PRIMARY KEY,
        ts REAL NOT NULL,
        event TEXT NOT NULL,
        detail TEXT NOT NULL,
        emotions_json TEXT NOT NULL
    );
    CREATE INDEX ix_emotion_events_ts ON emotion_events(ts);
    """,
    # Editable semantic overlay. WordNet itself stays read-only; these tables are Amy's own
    # copy of what she knows, where it came from, and how strongly she holds it.
    """
    CREATE TABLE semantic_nodes(
        id INTEGER PRIMARY KEY,
        term_type TEXT NOT NULL CHECK(term_type IN ('c','e')),
        term_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        wordnet_synset TEXT,
        seeded_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(term_type, term_id)
    );
    CREATE INDEX ix_semantic_nodes_term ON semantic_nodes(term_type, term_id);
    CREATE TABLE semantic_edges(
        id INTEGER PRIMARY KEY,
        subject_id INTEGER NOT NULL REFERENCES semantic_nodes(id),
        relation TEXT NOT NULL,
        object_id INTEGER REFERENCES semantic_nodes(id),
        literal TEXT,
        polarity INTEGER NOT NULL DEFAULT 1,
        origin TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        scope TEXT NOT NULL DEFAULT 'generic',
        context_json TEXT NOT NULL DEFAULT '{}',
        assertion_id INTEGER REFERENCES assertions(id),
        status TEXT NOT NULL DEFAULT 'active',
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(object_id IS NOT NULL OR literal IS NOT NULL)
    );
    CREATE INDEX ix_semantic_edges_subject ON semantic_edges(subject_id, relation, status);
    CREATE INDEX ix_semantic_edges_object ON semantic_edges(object_id, relation, status);
    CREATE INDEX ix_semantic_edges_assertion ON semantic_edges(assertion_id);
    CREATE TABLE semantic_evidence(
        id INTEGER PRIMARY KEY,
        edge_id INTEGER NOT NULL REFERENCES semantic_edges(id),
        assertion_id INTEGER REFERENCES assertions(id),
        utterance_id INTEGER REFERENCES utterances(id),
        source TEXT,
        origin TEXT NOT NULL,
        supports INTEGER NOT NULL DEFAULT 1,
        confidence REAL NOT NULL DEFAULT 1.0,
        context_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX ix_semantic_evidence_edge ON semantic_evidence(edge_id);
    CREATE TABLE semantic_inferences(
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        subject_id INTEGER NOT NULL REFERENCES semantic_nodes(id),
        relation TEXT NOT NULL,
        object_id INTEGER REFERENCES semantic_nodes(id),
        literal TEXT,
        confidence REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'supported',
        origin TEXT NOT NULL DEFAULT 'own-reasoning',
        path_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX ix_semantic_inferences_status ON semantic_inferences(status, confidence);
    CREATE TABLE semantic_gaps(
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        subject_id INTEGER NOT NULL REFERENCES semantic_nodes(id),
        relation TEXT NOT NULL,
        object_id INTEGER REFERENCES semantic_nodes(id),
        kind TEXT NOT NULL,
        question TEXT NOT NULL,
        pressure REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'open',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX ix_semantic_gaps_status ON semantic_gaps(status, pressure DESC);
    CREATE TABLE semantic_revisions(
        id INTEGER PRIMARY KEY,
        ts REAL NOT NULL,
        kind TEXT NOT NULL,
        edge_id INTEGER,
        assertion_id INTEGER,
        detail TEXT NOT NULL
    );
    CREATE INDEX ix_semantic_revisions_ts ON semantic_revisions(ts);
    CREATE TABLE semantic_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """,
    """
    ALTER TABLE utterances ADD COLUMN overheard INTEGER NOT NULL DEFAULT 0;
    """,
]
