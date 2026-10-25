# E1 progress — isolated vault + SEP-10 / hosted URL (25 Oct 2026)

**Not M1 PASS.** Unit tests and setup stages only.

| Item | Value |
| --- | --- |
| Branch tip (pre-push) | see PR #61 follow-up commit |
| Baseline vault (unchanged) | `CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN` token `CCZAEMZ…` USDC:`GBBO6N…` fee 100 |
| Event vault #2 | `CA5SYMIWGCUGG6OVTL3KBFNOWVEF46UILNKG7D7JMAD7XVQWX2W3ETMS` |
| Event token (SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| Event asset | `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| On-chain config | `[CBIELTK…, GDH7WGAQ…treasury, 100]` |
| Public ids file | `scripts/testnet/testnet-ids-anchor-vault.env` (Cursor-owned) |

## Stages

| Stage | Result |
| --- | --- |
| Trustlines payer + recipient A for anchor USDC | OK |
| Deploy vault #2 | OK (tx `b7c20ed6…`) |
| SEP-10 (fp-payer-demo) | OK |
| SEP-38 indicative `context=sep6` | OK (`price` returned) |
| SEP-24 deposit/interactive | OK — id `ab5dd0e1-…`, url sanitised `https://anchor-ref-ui-testanchor.stellar.org/` |
| SEP-24 withdraw/interactive | OK — id `f86e8295-…`, same sanitised host |
| Hosted UI completion / funding | **PENDING** (manual) |
| Classic memo payment | **NOT RUN** (helper implemented; needs memo fields after hosted) |
| Vault #2 Soroban deposit | **PENDING** (needs funded classic balance) |
| M1 completed withdraw | **NOT STARTED** |

## Coordination

Tx window doc: `scripts/testnet/EVENT-TX-WINDOWS.md`. Payer lock used for SEP-10/interactive only; unlocked after.
