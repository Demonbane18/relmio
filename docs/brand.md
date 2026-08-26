# Relmio brand

Relmio is the public name for the project formerly described as n8n OpenAI
OAuth Setup.

The name is intentionally client-agnostic. The current wizard configures a
private OpenAI-compatible OAuth sidecar for self-hosted n8n, while the product
direction can grow to support other OpenAI-compatible clients and SDK-based
applications.

## Logo and icon

![Relmio gateway android logo](images/brand/relmio-logo.png)

The **Gateway Android** turns Relmio's model relay into a friendly, minimal
guide standing inside a protected passage. Its teal face represents the live
AI connection, while the ivory arch depicts the local boundary through which
requests are deliberately relayed. The two quiet eyes keep it recognizable at
favicon size without borrowing another provider's branding.

The checked-in 512-pixel PNG is the canonical logo and icon asset. It was
derived from the selected generated source, then resized once for consistent
rendering across the README, hosted app, and local wizard.

## Colors

| Token | Hex | Use |
|---|---|---|
| Relay teal | `#137c74` | Primary lane, actions, active states |
| Midnight ink | `#12211f` | Secondary lane, text, high-contrast surfaces |
| Signal tint | `#e7f3f0` | Quiet selected and informational surfaces |
| Canvas | `#f4f2ed` | Warm application background |
| Gateway moss | `#8fa58b` | Logo field and calm supporting brand surfaces |

Keep the logo square and preserve its built-in moss background on both light
and dark surfaces. Do not crop, rotate, stretch, outline, recolor, or recreate
the logo with provider brand colors.

## Compatibility names

The public product and npm package use **Relmio** and `relmio`.

Existing remote paths, Docker project/service names, marker files, and local
credential paths keep their `n8n-openai-oauth` identifiers. Those values are
operational compatibility and safety boundaries, not the public brand.
