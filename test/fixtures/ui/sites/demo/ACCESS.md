# Access & safety checklist — Demo Clinic (synthetic fixture)

This file sits outside reports/ and must never be served by the dashboard.
Tick boxes with [x]. Items marked **(required)** block the pipeline until ticked.

## Before audit
- [x] (required) WordPress administrator login works for the person running the migration
- [x] (required) Full hosting backup (database + wp-content + config) downloaded off-server and test-opened
- [ ] Search Console access

## Before cutover
- [x] Domain zone access in Cloudflare
- [ ] Go-live token B scoped to this zone
- [ ] Rollback owner named:

<!-- wp2emdash:plugin-exports -->
## Plugin data (before extract)

The REST API does not expose these plugins' settings.

- [ ] (required) **Gravity Forms**: Forms → Import/Export → Export Forms
- [x] **Redirection**: Tools → Redirection → Import/Export → JSON
<!-- /wp2emdash:plugin-exports -->
