"""
Detects newly uploaded thumbnails and updates trip-itinerary.html.
Runs inside GitHub Actions — expects NEW_IMAGES and ANTHROPIC_API_KEY env vars.
"""

import os
import re
import json
import anthropic

PAGES_BASE = "https://ramophalatse.github.io/travel-widgets/assets/nyc-miami-2026/"
HTML_FILE = "trip-itinerary.html"


def write_output(**kwargs):
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        for key, value in kwargs.items():
            f.write(f"{key}={value}\n")


def write_pr_body(text: str):
    with open("/tmp/pr_body.md", "w") as f:
        f.write(text)


def extract_available_entries(html: str) -> list[str]:
    """Return act-name text for every activity-row that has no thumbnail yet."""
    pattern = re.compile(
        r'<div class="activity-row">.*?<div class="act-name">(.*?)</div>',
        re.DOTALL,
    )
    return pattern.findall(html)


def add_thumb(html: str, entry_name: str, image_filename: str) -> tuple[str, bool]:
    """
    Finds the activity-row containing entry_name and injects has-thumb + <img>.
    Uses a div-depth counter so it works on the minified single-line HTML.
    """
    target = f'<div class="act-name">{entry_name}</div>'
    idx = html.find(target)
    if idx == -1:
        return html, False

    row_marker = '<div class="activity-row">'
    row_start = html.rfind(row_marker, 0, idx)
    if row_start == -1:
        return html, False

    # Already has a thumb — skip
    if "has-thumb" in html[row_start : row_start + 60]:
        return html, False

    # Walk forward counting div depth to locate the matching closing </div>
    pos, depth, end = row_start, 0, -1
    while pos < len(html):
        if html[pos : pos + 4] == "<div" and html[pos + 4] in (">", " "):
            depth += 1
            pos += 4
        elif html[pos : pos + 6] == "</div>":
            depth -= 1
            if depth == 0:
                end = pos + 6
                break
            pos += 6
        else:
            pos += 1

    if end == -1:
        return html, False

    entry_html = html[row_start:end]
    src = PAGES_BASE + image_filename
    img = (
        f'<img class="act-thumb" src="{src}" alt="{entry_name}" '
        f"onclick=\"openLightbox(this.src,'{entry_name}')\" "
        f'loading="lazy" decoding="async">'
    )

    updated_entry = (
        entry_html.replace(row_marker, '<div class="activity-row has-thumb">', 1)[:-6]
        + img
        + "</div>"
    )

    return html[:row_start] + updated_entry + html[end:], True


def main():
    new_images = [
        f.strip()
        for f in os.environ.get("NEW_IMAGES", "").split(",")
        if f.strip()
    ]

    if not new_images:
        write_output(changed="false", confident="true")
        return

    with open(HTML_FILE) as f:
        html = f.read()

    available = extract_available_entries(html)
    if not available:
        write_output(changed="false", confident="true")
        return

    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-opus-4-7",
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": (
                    "Map each new thumbnail image to the most relevant activity entry "
                    "in a travel itinerary. Reply with JSON only — no commentary.\n\n"
                    f"New images: {json.dumps(new_images)}\n\n"
                    "Available entries (no thumbnail yet):\n"
                    + json.dumps(available, indent=2)
                    + "\n\nJSON schema:\n"
                    '{"confident": true, "mappings": [{"image": "thumb-foo.jpg", "entry": "exact entry text"}], "review_notes": ""}\n\n'
                    "Omit an image from mappings if no clear match exists. "
                    "Set confident=false and explain in review_notes if any match is ambiguous."
                ),
            }
        ],
    )

    try:
        result = json.loads(response.content[0].text.strip())
    except json.JSONDecodeError:
        write_output(changed="false", confident="false")
        write_pr_body("Claude returned an unparseable response. No changes were made.")
        return

    mappings = result.get("mappings", [])
    if not mappings:
        write_output(changed="false", confident="true")
        return

    updated_html, changed = html, False
    applied = []
    for m in mappings:
        updated_html, ok = add_thumb(updated_html, m["entry"], m["image"])
        if ok:
            changed = True
            applied.append(m)

    if not changed:
        write_output(changed="false", confident="true")
        return

    with open(HTML_FILE, "w") as f:
        f.write(updated_html)

    confident = result.get("confident", True)
    changes_md = "\n".join(f"- `{m['image']}` → _{m['entry']}_" for m in applied)
    body = f"## Thumbnail Updates\n\n{changes_md}"
    notes = result.get("review_notes", "")
    if notes:
        body += f"\n\n**Needs your confirmation:** {notes}"

    write_output(
        changed="true",
        confident="true" if confident else "false",
    )
    write_pr_body(body)


if __name__ == "__main__":
    main()
