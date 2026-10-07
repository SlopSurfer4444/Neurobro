"""Bounded OOXML inspection over stdin/stdout only. No extraction, network or third-party modules."""
import base64
import io
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET


def inspect(request):
    limits = request["limits"]
    raw = base64.b64decode(request["bytes"], validate=True)
    archive = zipfile.ZipFile(io.BytesIO(raw))
    infos = archive.infolist()
    if len(infos) > limits["maxEntries"]:
        raise ValueError("OOXML entry count exceeds configured limit")
    names = set()
    total = 0
    for info in infos:
        name = info.filename
        if name in names or name.startswith("/") or "\\" in name or ":" in name or ".." in name.split("/"):
            raise ValueError("Unsafe or duplicate OOXML entry")
        if info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError("Encrypted or unsupported OOXML compression")
        if info.file_size > limits["maxExpandedBytes"] or info.file_size / max(info.compress_size, 1) > limits["maxCompressionRatio"]:
            raise ValueError("OOXML expansion ratio/entry size exceeds configured limit")
        total += info.file_size
        names.add(name)
    if total > limits["maxExpandedBytes"]:
        raise ValueError("OOXML expanded bytes exceed configured limit")

    def xml(name):
        if name not in names:
            raise ValueError("Required OOXML part unavailable: " + name)
        with archive.open(name) as entry:
            data = entry.read(limits["maxExpandedBytes"] + 1)
        if data.startswith((b'\xff\xfe\x00\x00', b'\x00\x00\xfe\xff')):
            decoded = data.decode('utf-32')
        elif data.startswith((b'\xff\xfe', b'\xfe\xff')):
            decoded = data.decode('utf-16')
        else:
            decoded = data.decode('utf-8-sig')
        if '\x00' in decoded:
            raise ValueError('Unsupported XML encoding or null character')
        if len(data) > limits["maxExpandedBytes"] or re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", decoded, re.I):
            raise ValueError("Unsupported DTD/entity or oversized OOXML XML")
        root = ET.fromstring(data)
        if sum(1 for _ in root.iter()) > limits["maxXmlElements"]:
            raise ValueError("OOXML XML element count exceeds configured limit")
        return root

    offset = request["offset"]
    limit = request["limit"]
    if request["kind"] == "docx":
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        root = xml("word/document.xml")
        if root.tag != '{' + ns['w'] + '}document':
            raise ValueError('Unsupported DOCX namespace/document root')
        paragraphs = []
        for paragraph in root.findall(".//w:body//w:p", ns):
            pieces = []
            for node in paragraph.iter():
                local = node.tag.rsplit("}", 1)[-1]
                if local == "t":
                    pieces.append(node.text or "")
                elif local == "tab":
                    pieces.append("\t")
                elif local in ("br", "cr"):
                    pieces.append("\n")
            style = paragraph.find("w:pPr/w:pStyle", ns)
            paragraphs.append({"text": "".join(pieces), "style": None if style is None else style.get("{" + ns["w"] + "}val")})
        if offset > len(paragraphs):
            raise ValueError("Document paragraph offset exceeds total")
        omitted_parts = sorted(name for name in names if re.match(r"word/(?:header|footer|footnotes|endnotes|comments|media/|embeddings/)", name))
        return {"format": "docx", "unit": "paragraphs", "items": paragraphs[offset:offset + limit], "coverage": {"start": offset, "end": min(offset + limit, len(paragraphs)), "total": len(paragraphs), "more": offset + limit < len(paragraphs)}, "gaps": [{"reason": "Non-body content not extracted", "parts": omitted_parts}] if omitted_parts else [], "limitations": ["Body paragraphs and table cell text only; layout, images, headers, notes, comments and tracked-change acceptance are not visually inspected"]}

    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    workbook = xml("xl/workbook.xml")
    if workbook.tag != '{' + ns['s'] + '}workbook':
        raise ValueError('Unsupported XLSX namespace/workbook root')
    relationships = xml("xl/_rels/workbook.xml.rels")
    targets = {}
    for rel in relationships:
        if rel.get("TargetMode") == "External":
            continue
        target = rel.get("Target", "")
        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        if not path.startswith("xl/") or path not in names:
            raise ValueError("Unsafe or unavailable workbook relationship target")
        targets[rel.get("Id")] = path
    sheets = [{"name": sheet.get("name"), "state": sheet.get("state", "visible"), "part": targets.get(sheet.get("{" + ns["r"] + "}id"))} for sheet in workbook.findall("s:sheets/s:sheet", ns)]
    selected = request.get("sheet")
    if selected is None:
        if not sheets:
            raise ValueError("Workbook has no worksheets")
        selected = sheets[0]["name"]
    matches = [sheet for sheet in sheets if sheet["name"] == selected]
    if len(matches) != 1 or not matches[0]["part"]:
        raise ValueError("Worksheet unavailable or ambiguous")
    strings = []
    if "xl/sharedStrings.xml" in names:
        strings = ["".join(t.text or "" for t in item.findall(".//s:t", ns)) for item in xml("xl/sharedStrings.xml").findall("s:si", ns)]
    root = xml(matches[0]["part"])
    rows = []
    for row in root.findall("s:sheetData/s:row", ns):
        cells = []
        for cell in row.findall("s:c", ns):
            kind = cell.get("t", "n")
            value_node = cell.find("s:v", ns)
            raw_value = None if value_node is None else value_node.text
            value = raw_value
            if kind == "s":
                index = int(raw_value or "-1")
                if index < 0 or index >= len(strings):
                    raise ValueError("Shared string reference outside workbook")
                value = strings[index]
            elif kind == "inlineStr":
                value = "".join(t.text or "" for t in cell.findall(".//s:t", ns))
            formula = cell.find("s:f", ns)
            cells.append({"ref": cell.get("r"), "type": kind, "value": value, "rawValue": raw_value, "styleIndex": cell.get("s"), "formula": None if formula is None else formula.text, "formulaAttributes": None if formula is None else formula.attrib})
        rows.append({"row": row.get("r"), "cells": cells})
    if offset > len(rows):
        raise ValueError("Worksheet row offset exceeds total")
    return {"format": "xlsx", "unit": "stored rows", "sheet": selected, "sheets": sheets, "items": rows[offset:offset + limit], "coverage": {"start": offset, "end": min(offset + limit, len(rows)), "total": len(rows), "more": offset + limit < len(rows)}, "gaps": [{"reason": "Other worksheets not read in this page", "sheets": [sheet["name"] for sheet in sheets if sheet["name"] != selected]}] if len(sheets) > 1 else [], "limitations": ["Raw/cached cell values preserve XML strings; formulas are not recalculated, dates/styles not converted, charts/images/macros not interpreted"]}


try:
    request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    result = inspect(request)
    encoded = json.dumps({"ok": True, "inspection": result}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > request["limits"]["maxOutputBytes"]:
        raise ValueError("Inspection output exceeds configured limit; request a smaller explicit page")
    sys.stdout.buffer.write(encoded)
except Exception as error:
    sys.stdout.buffer.write(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False).encode("utf-8"))
    sys.exit(1)
