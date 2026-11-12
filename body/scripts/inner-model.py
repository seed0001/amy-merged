"""Train and sample a local New Champ specialist."""
import hashlib
import json
import os
from pathlib import Path
import random
import sqlite3
import sys
import time


def records(data, recipe):
    sources = recipe["sources"]
    rows = []
    database = data / "companion.db"
    if database.exists():
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "thoughts" in sources and "thoughts" in tables:
                rows.extend(("thoughts", topic, content) for topic, content in db.execute(
                    "SELECT topic, content FROM thoughts ORDER BY id"))
            if "memories" in sources and "memories" in tables:
                rows.extend(("memories", "Recall a recorded fact", content) for content, in db.execute(
                    "SELECT content FROM memories WHERE user_id IN (SELECT value FROM json_each(?)) ORDER BY id",
                    (json.dumps(recipe["owners"]),)))
            if "chats" in sources and "messages" in tables:
                pending = {}
                for conversation, role, user, content in db.execute(
                    "SELECT conversation, role, user_id, content FROM messages ORDER BY id"
                ):
                    if role == "user":
                        pending[conversation] = content if user in recipe["owners"] else None
                    elif role == "assistant":
                        prompt = pending.pop(conversation, None)
                        if prompt:
                            rows.append(("chats", prompt, content))
    if "journal" in sources:
        for file in sorted((data / "journal").glob("*.md")):
            rows.extend(("journal", "Reflect on " + file.stem, entry)
                        for entry in file.read_text(encoding="utf-8").split("\n## "))
    for name in ("synthesis", "face"):
        examples = data / "inner-models" / f"{name}.jsonl"
        if name in sources and examples.exists():
            for line in examples.read_text(encoding="utf-8").splitlines():
                try:
                    example = json.loads(line)
                    rows.append((name, example["input"], example["reply"]))
                except (ValueError, KeyError):
                    continue
    return list(dict.fromkeys((source, prompt.strip(), answer.strip())
                              for source, prompt, answer in rows if answer and answer.strip()))


def format_prompt(recipe, text):
    return f"[{recipe['model']}]\n{text}\n[response]\n"


def network(torch, recipe, vocab):
    nn = torch.nn

    class Model(nn.Module):
        def __init__(self):
            super().__init__()
            width = recipe["width"]
            self.tokens = nn.Embedding(vocab, width)
            self.position = nn.Embedding(recipe["context"], width)
            self.blocks = nn.ModuleList(nn.TransformerEncoderLayer(
                width, recipe["heads"], width * 4, dropout=0.0,
                activation="gelu", batch_first=True, norm_first=True
            ) for _ in range(recipe["layers"]))
            self.norm = nn.LayerNorm(width)
            self.output = nn.Linear(width, vocab, bias=False)
            self.output.weight = self.tokens.weight

        def forward(self, tokens):
            length = tokens.shape[1]
            hidden = self.tokens(tokens) + self.position(torch.arange(length, device=tokens.device))
            mask = torch.ones(length, length, dtype=torch.bool, device=tokens.device).triu(1)
            for block in self.blocks:
                hidden = block(hidden, src_mask=mask)
            return self.output(self.norm(hidden))

    return Model()


def device_for(torch, recipe):
    if recipe["device"] == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return recipe["device"]


def train(run, data):
    import torch
    from tokenizers import ByteLevelBPETokenizer, Tokenizer

    recipe = json.loads((run / "recipe.json").read_text(encoding="utf-8"))
    started = time.time()
    rng = random.Random(42)
    torch.manual_seed(42)
    torch.set_num_threads(min(2, os.cpu_count() or 1))
    device = device_for(torch, recipe)

    def status(state, **details):
        temp = run / "status.tmp"
        temp.write_text(json.dumps(dict(state=state, started=started, device=device, **details)), encoding="utf-8")
        temp.replace(run / "status.json")

    status("running", step=0)
    parent = Path(recipe["parent"]) if recipe["parent"] else None
    fresh = records(data, recipe)
    old = []
    if parent:
        old = [tuple(row) for row in json.loads((parent / "dataset.json").read_text(encoding="utf-8"))
               if row[0] in recipe["sources"]]
    rows = list(dict.fromkeys(old + fresh))
    # Split on the whole example: answers repeat (face labels most of all), so they can't decide it alone.
    holdout = [row for row in rows if int(hashlib.sha256(f"{row[1]}\n{row[2]}".encode()).hexdigest(), 16) % 10 == 0]
    held = set(holdout)
    training = [row for row in rows if row not in held]
    if not training or not holdout:
        raise ValueError("Need enough distinct records for both training and held-out evaluation.")
    (run / "dataset.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")

    def document(row):
        source, prompt, answer = row
        return format_prompt(recipe, f"[{source}] {prompt}") + answer

    if parent:
        checkpoint = torch.load(parent / "model.pt", map_location="cpu", weights_only=True)
        for key in ("width", "heads", "layers", "context", "vocab"):
            if checkpoint["recipe"][key] != recipe[key]:
                raise ValueError(f"Changing {key} requires training from scratch.")
        tokenizer = Tokenizer.from_file(str(parent / "tokenizer.json"))
    else:
        bpe = ByteLevelBPETokenizer()
        bpe.train_from_iterator(map(document, training), vocab_size=recipe["vocab"],
                                special_tokens=["<end>"])
        tokenizer = Tokenizer.from_str(bpe.to_str())
    tokenizer.save(str(run / "tokenizer.json"))
    end = tokenizer.token_to_id("<end>")
    model = network(torch, recipe, tokenizer.get_vocab_size()).to(device)
    if parent:
        model.load_state_dict(checkpoint["weights"])
    optimizer = torch.optim.AdamW(model.parameters(), lr=recipe["lr"])
    size = sum(p.numel() for p in model.parameters())
    length = recipe["context"]

    def encode(items):
        return [tokenizer.encode(document(row)).ids + [end] for row in items]

    old_set = set(old)
    new_tokens = encode([row for row in training if row not in old_set])
    replay = encode([row for row in training if row in old_set])
    validation = encode(holdout[:64])

    def loss(batch, random_window=True):
        inputs, labels = [], []
        for seq in batch:
            start = rng.randrange(max(1, len(seq) - length)) if random_window else 0
            part = seq[start:start + length + 1]
            inputs.append(part[:-1] + [end] * (length + 1 - len(part)))
            labels.append(part[1:] + [-100] * (length + 1 - len(part)))
        x, y = (torch.tensor(value, device=device) for value in (inputs, labels))
        logits = model(x)
        return torch.nn.functional.cross_entropy(logits.flatten(0, 1), y.flatten())

    def evaluate():
        model.eval()
        with torch.inference_mode():
            value = sum(loss([seq], False).item() for seq in validation) / len(validation)
        model.train()
        return value

    baseline = evaluate()
    step = 0
    control = run / "control"

    def command():
        return control.read_text(encoding="utf-8") if control.exists() else ""

    for index in range(recipe["steps"]):
        if command() == "pause":
            status("paused", step=step, steps=recipe["steps"], parameters=size)
            while command() == "pause":
                time.sleep(0.5)
            status("running", step=step, steps=recipe["steps"], parameters=size)
        if command() == "stop":
            break
        batch = [rng.choice(replay if replay and (not new_tokens or rng.random() < 0.5)
                            else new_tokens) for _ in range(recipe["batch"])]
        optimizer.zero_grad(set_to_none=True)
        value = loss(batch)
        value.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        step = index + 1
        if step == 1 or step % 10 == 0:
            status("running", step=step, steps=recipe["steps"], parameters=size, loss=value.item())
    score = evaluate()
    torch.save({"weights": model.state_dict(), "recipe": {
        key: recipe[key] for key in ("width", "layers", "heads", "context", "vocab", "model", "device")
    }}, run / "model.tmp")
    (run / "model.tmp").replace(run / "model.pt")
    status("stopped" if step < recipe["steps"] else "complete", step=step, steps=recipe["steps"],
           parameters=size, records=len(rows), held_out=len(holdout),
           validation_loss=score, starting_validation_loss=baseline)


def sample(run, prompt, consult=False):
    import torch
    from tokenizers import Tokenizer

    torch.set_num_threads(min(2, os.cpu_count() or 1))
    saved = torch.load(run / "model.pt", map_location="cpu", weights_only=True)
    recipe = saved["recipe"]
    tokenizer = Tokenizer.from_file(str(run / "tokenizer.json"))
    model = network(torch, recipe, tokenizer.get_vocab_size())
    model.load_state_dict(saved["weights"])
    model.eval()
    end = tokenizer.token_to_id("<end>")
    limit = 64
    if consult:
        payload = json.loads(prompt)
        limit = min(32, recipe["context"] // 4)
        budget = recipe["context"] - limit
        encode = lambda text: tokenizer.encode(text).ids
        prefix = encode(f"[{recipe['model']}]\n")
        suffix = encode("\n[response]\n")
        available = max(1, budget - len(prefix) - len(suffix))
        task = encode(payload["task"] + "\n")[:available // 4]
        question = encode(payload["text"])[:max(1, (available - len(task)) * 2 // 3)]
        remaining = available - len(task) - len(question)
        history = []
        for record in reversed(payload["records"]):
            if remaining <= 0:
                break
            chunk = encode("\n" + record)
            history[:0] = chunk[:remaining]
            remaining -= min(len(chunk), remaining)
        tokens = (prefix + task + question + history + suffix)[-budget:]
    else:
        tokens = tokenizer.encode(format_prompt(recipe, prompt)).ids
    generated = []
    with torch.inference_mode():
        for _ in range(limit):
            logits = model(torch.tensor([tokens[-recipe["context"]:]]))[0, -1]
            token = logits.argmax().item()
            if token == end:
                break
            tokens.append(token)
            generated.append(token)
    print(tokenizer.decode(generated))


if __name__ == "__main__":
    action, folder, value = sys.argv[1:]
    run = Path(folder).resolve()
    if action == "train":
        try:
            train(run, Path(value).resolve())
        except Exception as error:
            (run / "status.json").write_text(json.dumps({"state": "failed", "error": str(error),
                                                        "started": time.time()}), encoding="utf-8")
            raise
    else:
        sample(run, value, consult=action == "consult")
