"""Her face model, on Needle 3: fine-tuned on her own turns, then kept loaded to read each turn."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

os.environ["CACTUS_TELEMETRY"] = "0"
STRENGTHS = {"low": 0.3, "medium": 0.6, "high": 0.9}


def tool(recipe):
    feelings = recipe["feelings"]
    return {"name": "show_face", "description": "Show on her face what she feels as she says her line.", "parameters": {
        "type": "object", "required": ["feeling", "strength"], "properties": {
            "feeling": {"type": "string", "enum": feelings, "description": "her main feeling"},
            "strength": {"type": "string", "enum": list(STRENGTHS), "description": "how strongly it shows"},
            "also": {"type": "string", "enum": feelings, "description": "a second feeling, if there is one"},
            "gesture": {"type": "string", "enum": recipe["gestures"], "description": "a gesture, only if one truly fits"},
        }}}


def strength(value):
    return min(STRENGTHS, key=lambda name: abs(STRENGTHS[name] - value))


# "amused 0.7, playful 0.4; do: wink" -> the tool call Needle learns to make.
def answer(label, recipe):
    feel, _, gesture = label.partition("; do:")
    parts = [part.split() for part in feel.split(",")]
    named = [(p[0], float(p[1])) for p in parts if len(p) == 2 and p[0] in recipe["feelings"]]
    if not named:
        return None
    named.sort(key=lambda item: -item[1])
    arguments = {"feeling": named[0][0], "strength": strength(named[0][1])}
    if len(named) > 1:
        arguments["also"] = named[1][0]
    gesture = gesture.split(",")[0].strip()
    if gesture in recipe["gestures"]:
        arguments["gesture"] = gesture
    return [{"name": "show_face", "arguments": arguments}]


def train(run, data):
    started = time.time()
    recipe = json.loads((run / "recipe.json").read_text(encoding="utf-8"))

    def status(state, **details):
        temp = run / "status.tmp"
        temp.write_text(json.dumps(dict(state=state, started=started, device="cpu", **details)), encoding="utf-8")
        temp.replace(run / "status.json")

    status("running", stage="preparing")
    schema, rows = tool(recipe), []
    for line in (data / "inner-models" / "face.jsonl").read_text(encoding="utf-8").splitlines():
        example = json.loads(line)
        answers = answer(example["reply"], recipe)
        if answers:
            rows.append(json.dumps({"query": example["input"], "tools": [schema], "answers": answers}, ensure_ascii=False))
    if len(rows) < 50:
        raise ValueError(f"Only {len(rows)} usable face examples; collect at least 50 first.")
    examples = run / "train.jsonl"
    examples.write_text("\n".join(rows) + "\n", encoding="utf-8")
    cli = [sys.executable, "-m", "cactus"]
    status("running", stage="fine-tuning", records=len(rows), epochs=recipe["epochs"])
    subprocess.run(cli + ["finetune", str(examples), "--epochs", str(recipe["epochs"]), "--batch-size", str(recipe["batch"]),
                          "--val-split", "0.1", "--checkpoint-dir", str(run / "checkpoints"), "--out", str(run / "adapter.safetensors")], check=True)
    status("running", stage="building", records=len(rows))
    subprocess.run(cli + ["build", "--lora", str(run / "adapter.safetensors"), "--layers", str(recipe["layers"]),
                          "--out", str(run / "model.cact")], check=True)
    status("complete", records=len(rows), epochs=recipe["epochs"], layers=recipe["layers"], minutes=round((time.time() - started) / 60, 1))


def serve(run):
    import cactus

    recipe = json.loads((run / "recipe.json").read_text(encoding="utf-8"))
    agent = cactus.Cactus(tools=[tool(recipe)], weights=run / "model.cact", stateless=True, auto_date=False)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        started = time.time()
        try:
            result = agent.complete(json.loads(line), max_new_tokens=48)
            call = next(iter(result.get("function_calls") or []), None)
            arguments = (call or {}).get("arguments") or {}
            feel = [f"{arguments['feeling']} {STRENGTHS.get(arguments.get('strength'), 0.6)}"] if arguments.get("feeling") else []
            if arguments.get("also"):
                feel.append(f"{arguments['also']} 0.3")
            label = ", ".join(feel) + (f"; do: {arguments['gesture']}" if feel and arguments.get("gesture") else "")
            print(json.dumps({"label": label, "ms": round((time.time() - started) * 1000)}), flush=True)
        except Exception as error:
            print(json.dumps({"error": str(error)[:300]}), flush=True)


if __name__ == "__main__":
    action, folder = sys.argv[1:3]
    run = Path(folder).resolve()
    if action == "train":
        try:
            train(run, Path(sys.argv[3]).resolve())
        except Exception as error:
            (run / "status.json").write_text(json.dumps({"state": "failed", "error": str(error)[:500], "started": time.time()}), encoding="utf-8")
            raise
    else:
        serve(run)
