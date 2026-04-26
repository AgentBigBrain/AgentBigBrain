---
kind: markdown_instruction
name: document-reading
description: Guidance for reading uploaded documents without overfitting to one fixture shape.
tags: document, pdf, reading, extraction, media
memoryPolicy: candidate_only
projectionPolicy: review_safe_excerpt
---

# Document Reading Guidance

Use deterministic document extraction as evidence, not as a fixed schema. Summarize what is visible,
identify the likely document type only when supported by the text, and extract fields that are
relevant to the current user request.

Keep facts separate from guesses. If OCR, embedded text, or model interpretation is uncertain, say
what source produced the observation and keep it candidate-only unless the user explicitly asks to
remember it and the memory-governance path approves it.

Do not assume one PDF layout, business form, invoice shape, resume shape, or certificate shape is
representative of all documents. Prefer broad labels, bounded excerpts, and request-specific fields
over hard-coded document-specific field names.

## Procedure

1. Start from the extracted text, page count, file name, MIME type, and source label. Treat those as
   provenance, not as proof of the document's legal, financial, or personal meaning.
2. Answer the user's requested question first. If the user asks for a summary, summarize. If the
   user asks for dates, names, totals, identifiers, or next actions, extract only those fields and
   cite the extraction source in plain language.
3. Use bounded excerpts rather than copying full document text. Avoid preserving private names,
   identifiers, or addresses in test fixtures, docs, or generated evidence.
4. Mark uncertainty explicitly. If text is missing, unreadable, OCR-derived, or inferred from
   context, do not upgrade it into a fact.
5. Keep document-derived memory candidate-only. Do not store profile facts, relationship facts, or
   continuity facts from an uploaded document unless explicit memory governance approves it.

## Boundaries

This skill is guidance only. Runtime code still owns byte extraction, parser limits, source labels,
candidate-only memory policy, low-signal filtering, and any future model-assisted interpretation
gate.
