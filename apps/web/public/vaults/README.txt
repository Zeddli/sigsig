Known vaults for the live data source (VITE_DATA_SOURCE=live), one file per network:

  [
    {
      "id": "ops-treasury",
      "name": "Ops treasury",
      "params": { "paryonTokenId": "…", "loanKeyCategory": "…", "stateCategory": "…",
                  "signerPubkeys": ["02…", "03…", "02…"], "m": 2 },
      "payees": [ { "label": "Payroll — Ops", "address": "bitcoincash:q…" } ],
      "signers": ["Treasurer", "Ops lead", "Board seat"]
    }
  ]

The payees list must be the full allowlist in the order packages/core/src/vault/payees.ts hashes it
(it is used for the merkle proof). The live source also fetches /deployments/chipnet.json (the Paryon
chipnet deployment written by packages/oracle); copy it into public/deployments/ when it is published.
