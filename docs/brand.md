# PlanRelay brand

PlanRelay is the public name for the project formerly described as n8n OpenAI
OAuth Setup.

The name is intentionally client-agnostic. The current wizard configures a
private OpenAI-compatible OAuth sidecar for self-hosted n8n, while the product
direction can grow to support other OpenAI-compatible clients and SDK-based
applications.

## Mark

![PlanRelay mark](images/brand/planrelay-mark.svg)

Two independent lanes converge around a right-facing negative-space arrow. The
shape represents an authenticated upstream connection being relayed through a
single compatible interface.

The mark was developed from the checked-in generated concept source at
[`images/brand/planrelay-concept-source.png`](images/brand/planrelay-concept-source.png)
and redrawn as compact SVG geometry for reliable rendering at small sizes.

## Colors

| Token | Hex | Use |
|---|---|---|
| Relay teal | `#137c74` | Primary lane, actions, active states |
| Midnight ink | `#12211f` | Secondary lane, text, high-contrast surfaces |
| Signal tint | `#e7f3f0` | Quiet selected and informational surfaces |
| Canvas | `#f4f2ed` | Warm application background |

Use the two-color mark on light backgrounds. On a dark surface, place the
unchanged mark on a white or canvas-colored tile with enough padding. Do not
rotate, stretch, outline, add gradients, or recreate the mark with provider
brand colors.

## Compatibility names

The public product and npm package use **PlanRelay** and `planrelay`.

Existing remote paths, Docker project/service names, marker files, and local
credential paths keep their `n8n-openai-oauth` identifiers. Those values are
operational compatibility and safety boundaries, not the public brand.
