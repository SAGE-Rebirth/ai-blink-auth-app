# RBAC Permission Schema

| Resource | Admin | Org Owner | User | Temp User |
|---|---|---|---|---|
| **users** | CRUD | CRUD | R, U (self) | R |
| **organizations** | CRUD | R, U | R | R |
| **verification_sessions** | CRUD | CRUD | C, R | C, R |
| **verification_results** | CRUD | R, U, D | R | R |
| **audit_logs** | CRUD | R | - | - |
| **settings** | CRUD | CRUD | R, U | - |
| **roles** | CRUD | CRUD | - | - |
| **api_keys** | CRUD | CRUD | - | - |
