# Request templates

Each block is a complete, valid request (the package tests check every block against the schemas). Replace the example values:

- every `operationId` is a fresh UUID v4;
- `inputDigest`, `artifactDigest`, artifact keys and source `digest` are SHA-256 hashes you compute with `anagenesis digest --file`;
- `expectedDigest` and `candidateDigest` come from `anagenesis digest --path <workspacePath>`;
- `policyDigest`, `suiteDigest`, `candidateId`, `baseVersion` and `baseDigest` are copied from the `create` or `improve` response (`evaluationPlan.policyDigest`, `evaluationPlan.attempts[i].suiteDigest`);
- `<…>` values are your own text or paths.

Unknown fields are rejected.

## create

Holdouts are groups of exam cases: one group per attempt, the first used now and the others kept for retries. `requiresIsolation: true` means every run of that case must be `isolated: true`. `inputDigest` is the SHA-256 of the case input text, computed by the examiner.

```json create
{
  "schemaVersion": 1,
  "operationId": "3b1f8a52-6c4e-4c1a-9d2e-7f0a1b2c3d4e",
  "skillId": "zoho-mail",
  "objective": "Search, answer with templates and archive Zoho Mail messages",
  "boundaries": ["Never delete messages", "Ask before sending"],
  "audience": "People who handle work mail in Zoho",
  "sources": [
    {
      "uri": "https://www.zoho.com/mail/help/api/",
      "revision": "2026-11",
      "digest": "4f61022d0af325afa3740d247a8da2319c7e615d3d311f41d35b95ea284422e9"
    }
  ],
  "examples": [
    {
      "input": "Find the October invoices",
      "expected": "List with sender, date and subject"
    }
  ],
  "successCriteria": ["Replies to customers are sent from sales@"],
  "author": {
    "producer": "agent-cli",
    "model": "your-model",
    "modelVersion": "your-model-version"
  },
  "reason": "First version",
  "policy": {
    "metric": "soft",
    "mixedWeight": 0.5,
    "aggregation": "mean",
    "repetitions": 1,
    "minimumHoldout": 2,
    "thresholds": { "hard": 0, "soft": 0.7 },
    "regressionTolerance": { "hard": 0, "soft": 0 },
    "development": [
      {
        "id": "dev-invoices",
        "inputDigest": "8a99252b2db0a18f09d6c9af88537aaba53f32f2b345ce5f81e3784a485c4bfe",
        "requiresIsolation": false,
        "prompt": "Find the October invoices",
        "expected": "List with sender, date and subject"
      }
    ],
    "holdouts": [
      [
        {
          "id": "holdout-quote",
          "inputDigest": "5a2033382f74f00c5bf1e8b157c7acced2dc81e3c292c8ccfb5a3ba63f8ba0d6",
          "requiresIsolation": true
        },
        {
          "id": "holdout-supplier",
          "inputDigest": "a6fe3595853b5273afa85e348202bd953b8b8193994b8391c83a4676e6c80214",
          "requiresIsolation": true
        }
      ],
      [
        {
          "id": "holdout-spare-1",
          "inputDigest": "2b3d363a12a0a47053d9a7a620f7a40fb248bce0c325e8bb8856c60bf4efa9f7",
          "requiresIsolation": true
        },
        {
          "id": "holdout-spare-2",
          "inputDigest": "3eee28e86ee2e80ee1577467676790e5b36ea6992667621ee83a8494ec47af9b",
          "requiresIsolation": true
        }
      ]
    ],
    "regression": [
      {
        "id": "reg-newsletters",
        "inputDigest": "5d15fc6ae047ff48b1c5e9c92e6ba60973510466ebe4ca49f6b47a4a5a9d0208",
        "requiresIsolation": true
      }
    ],
    "limits": { "maxFiles": 50, "maxBytes": 500000, "maxFileBytes": 100000 },
    "evaluation": {
      "model": "your-model",
      "modelVersion": "your-model-version",
      "configuration": { "temperature": 0 },
      "tools": ["zoho_mail"],
      "environment": "zoho-sandbox",
      "budget": 100,
      "verifierId": "zoho-checklist",
      "verifierVersion": "1"
    }
  }
}
```

## run

One record per runner answer, returned by the examiner. Settings must equal `policy.evaluation` exactly. `hard` is 1 for `pass` and 0 for `fail`; `soft` is the checklist share. `artifactDigest` is the SHA-256 of the exact answer text, which goes into the manifest's `artifacts`. Baseline and candidate of the same case share `caseId`, `repetition`, `seed` and `isolated`; every `runId` is unique.

```json run
{
  "runId": "run-holdout-quote-with-skill-0",
  "caseId": "holdout-quote",
  "split": "holdout",
  "repetition": 0,
  "inputDigest": "5a2033382f74f00c5bf1e8b157c7acced2dc81e3c292c8ccfb5a3ba63f8ba0d6",
  "artifactDigest": "9f2c1d0b8e7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e",
  "outcome": "fail",
  "hard": 0,
  "soft": 0.75,
  "verifierId": "zoho-checklist",
  "verifierVersion": "1",
  "timestamp": "2026-11-16T09:30:00.000Z",
  "producer": "examiner",
  "model": "your-model",
  "modelVersion": "your-model-version",
  "configuration": { "temperature": 0 },
  "tools": ["zoho_mail"],
  "environment": "zoho-sandbox",
  "budget": 100,
  "seed": null,
  "origin": "agent",
  "sessionId": "examiner-session-1",
  "isolated": true
}
```

## mining

Written by the author after creating the skill, outside the workspace. For each creation stage, the source URIs or development case ids it used; every reference must appear in the request's `sources` or `policy.development`.

```json mining
{
  "workflow": {
    "sources": ["https://www.zoho.com/mail/help/api/"],
    "summary": "Search, reply, archive and their decision points"
  },
  "tools": {
    "sources": ["https://www.zoho.com/mail/help/api/"],
    "summary": "Search, send and move endpoints with their arguments"
  },
  "knowledge": {
    "sources": ["dev-invoices"],
    "summary": "Folder names and the sales@ alias"
  },
  "synthesis": {
    "sources": ["https://www.zoho.com/mail/help/api/", "dev-invoices"],
    "summary": "SKILL.md with long detail in references/"
  }
}
```

## diagnosis

Written by the author before changing a skill in `improve`, outside the workspace. `evidenceIds` cite feedback ids, development case ids or source URIs. `category` is `skill`, `tool`, `data`, `environment` or `execution`; skill entries add `defect` (`knowledge`, `tool_usage`, `clarification`, `style`) and every file they change. Every changed file must be covered.

```json diagnosis
[
  {
    "evidenceIds": ["b02a5d98-ec76-49b5-8d9c-b3074539c140"],
    "cause": "The skill does not say to set fromAddress to the team alias",
    "category": "skill",
    "defect": "tool_usage",
    "files": ["SKILL.md"],
    "sections": ["Sending a reply"],
    "minimalChange": "For customer replies use fromAddress = sales@",
    "expectedTest": "The quote reply is sent from sales@"
  }
]
```

## submit-create

Built and sent by the examiner. `results` holds one `{baseline, candidate}` pair per case and repetition of the chosen attempt plus every regression case; the example shows one pair. `mining` is the author's mining file, unchanged.

```json submit-create
{
  "schemaVersion": 1,
  "operationId": "7d2e9c41-0a3b-4f5c-8e6d-1a2b3c4d5e6f",
  "candidateId": "2a6d9204-e654-4a06-83ee-0198045a0f3e",
  "expectedDigest": "8b833540f13f6a74442ca0256105c3f2931de70bed3dea2e55f3202a9d0aff14",
  "evidenceManifest": {
    "schemaVersion": 1,
    "candidateDigest": "8b833540f13f6a74442ca0256105c3f2931de70bed3dea2e55f3202a9d0aff14",
    "baseVersion": null,
    "baseDigest": null,
    "baselineKind": "without_skill",
    "policyDigest": "216b65c69fc17e933cc9238bd1ead9332bcdde73579910c244cb915c514b2feb",
    "suiteDigest": "1be6d4c1d44d7dac31ae15f2efd96c18280e78140ab051a0d032b78db47faae7",
    "holdoutIndex": 0,
    "authorExposed": false,
    "results": [
      {
        "baseline": {
          "runId": "run-holdout-quote-without-skill-0",
          "caseId": "holdout-quote",
          "split": "holdout",
          "repetition": 0,
          "inputDigest": "5a2033382f74f00c5bf1e8b157c7acced2dc81e3c292c8ccfb5a3ba63f8ba0d6",
          "artifactDigest": "0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d",
          "outcome": "fail",
          "hard": 0,
          "soft": 0.25,
          "verifierId": "zoho-checklist",
          "verifierVersion": "1",
          "timestamp": "2026-11-16T09:29:00.000Z",
          "producer": "examiner",
          "model": "your-model",
          "modelVersion": "your-model-version",
          "configuration": { "temperature": 0 },
          "tools": ["zoho_mail"],
          "environment": "zoho-sandbox",
          "budget": 100,
          "seed": null,
          "origin": "agent",
          "sessionId": "examiner-session-1",
          "isolated": true
        },
        "candidate": {
          "runId": "run-holdout-quote-with-skill-0",
          "caseId": "holdout-quote",
          "split": "holdout",
          "repetition": 0,
          "inputDigest": "5a2033382f74f00c5bf1e8b157c7acced2dc81e3c292c8ccfb5a3ba63f8ba0d6",
          "artifactDigest": "9f2c1d0b8e7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e",
          "outcome": "fail",
          "hard": 0,
          "soft": 0.75,
          "verifierId": "zoho-checklist",
          "verifierVersion": "1",
          "timestamp": "2026-11-16T09:30:00.000Z",
          "producer": "examiner",
          "model": "your-model",
          "modelVersion": "your-model-version",
          "configuration": { "temperature": 0 },
          "tools": ["zoho_mail"],
          "environment": "zoho-sandbox",
          "budget": 100,
          "seed": null,
          "origin": "agent",
          "sessionId": "examiner-session-1",
          "isolated": true
        }
      }
    ],
    "artifacts": {
      "0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d": "<exact baseline answer text>",
      "9f2c1d0b8e7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e": "<exact candidate answer text>"
    }
  },
  "mining": {
    "workflow": {
      "sources": ["https://www.zoho.com/mail/help/api/"],
      "summary": "Search, reply, archive and their decision points"
    },
    "tools": {
      "sources": ["https://www.zoho.com/mail/help/api/"],
      "summary": "Search, send and move endpoints with their arguments"
    },
    "knowledge": {
      "sources": ["dev-invoices"],
      "summary": "Folder names and the sales@ alias"
    },
    "synthesis": {
      "sources": ["https://www.zoho.com/mail/help/api/", "dev-invoices"],
      "summary": "SKILL.md with long detail in references/"
    }
  }
}
```

## feedback

`version` and `artifactDigest` come from `resolve`. If the version is unknown, use `null` for both. `analysis` rates each dimension `none`, `low`, `medium` or `high`.

```json feedback
{
  "schemaVersion": 1,
  "operationId": "b02a5d98-ec76-49b5-8d9c-b3074539c140",
  "skillId": "zoho-mail",
  "version": 1,
  "artifactDigest": "8b833540f13f6a74442ca0256105c3f2931de70bed3dea2e55f3202a9d0aff14",
  "runId": "session-2026-11-18-quote",
  "producer": "agent-cli",
  "timestamp": "2026-11-18T10:42:00.000Z",
  "source": {
    "uri": "https://www.zoho.com/mail/help/api/",
    "revision": "2026-11",
    "digest": "4f61022d0af325afa3740d247a8da2319c7e615d3d311f41d35b95ea284422e9"
  },
  "observation": "The reply to the customer was sent from the personal address",
  "expected": "Sender sales@company.example",
  "actual": "Sender mario@company.example",
  "evidenceRefs": ["sent message 2026-11-18 10:42"],
  "category": "tool_usage",
  "possibleCause": "The skill does not say which fromAddress to use",
  "analysis": {
    "knowledge": "none",
    "toolUsage": "high",
    "clarification": "none",
    "style": "none"
  }
}
```

A correction that the problem was not the skill's fault adds `"supersedes": "<original feedbackId>"` and `"disposition": "not_skill"` to a new feedback with its own `operationId`.

## improve

All `create` fields with new exam cases, plus the active version and the feedback to address.

```json improve
{
  "schemaVersion": 1,
  "operationId": "c4d5e6f7-8a9b-4c0d-9e1f-2a3b4c5d6e7f",
  "skillId": "zoho-mail",
  "objective": "Search, answer with templates and archive Zoho Mail messages",
  "boundaries": ["Never delete messages", "Ask before sending"],
  "audience": "People who handle work mail in Zoho",
  "sources": [
    {
      "uri": "https://www.zoho.com/mail/help/api/",
      "revision": "2026-11",
      "digest": "4f61022d0af325afa3740d247a8da2319c7e615d3d311f41d35b95ea284422e9"
    }
  ],
  "examples": [
    {
      "input": "Find the October invoices",
      "expected": "List with sender, date and subject"
    }
  ],
  "successCriteria": ["Replies to customers are sent from sales@"],
  "author": {
    "producer": "agent-cli",
    "model": "your-model",
    "modelVersion": "your-model-version"
  },
  "reason": "Wrong sender in replies to customers",
  "policy": {
    "metric": "soft",
    "mixedWeight": 0.5,
    "aggregation": "mean",
    "repetitions": 1,
    "minimumHoldout": 1,
    "thresholds": { "hard": 0, "soft": 0.7 },
    "regressionTolerance": { "hard": 0, "soft": 0 },
    "development": [
      {
        "id": "dev-invoices",
        "inputDigest": "8a99252b2db0a18f09d6c9af88537aaba53f32f2b345ce5f81e3784a485c4bfe",
        "requiresIsolation": false,
        "prompt": "Find the October invoices",
        "expected": "List with sender, date and subject"
      }
    ],
    "holdouts": [
      [
        {
          "id": "holdout-quote-2",
          "inputDigest": "c0ffee0a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbc",
          "requiresIsolation": true
        }
      ]
    ],
    "regression": [
      {
        "id": "reg-newsletters",
        "inputDigest": "5d15fc6ae047ff48b1c5e9c92e6ba60973510466ebe4ca49f6b47a4a5a9d0208",
        "requiresIsolation": true
      }
    ],
    "limits": { "maxFiles": 50, "maxBytes": 500000, "maxFileBytes": 100000 },
    "evaluation": {
      "model": "your-model",
      "modelVersion": "your-model-version",
      "configuration": { "temperature": 0 },
      "tools": ["zoho_mail"],
      "environment": "zoho-sandbox",
      "budget": 100,
      "verifierId": "zoho-checklist",
      "verifierVersion": "1"
    }
  },
  "expectedVersion": 1,
  "feedbackIds": ["b02a5d98-ec76-49b5-8d9c-b3074539c140"]
}
```

## submit-improve

Same as `submit-create`, with `baseVersion`/`baseDigest` from the improve response, `baselineKind: "revision"`, the base version as the baseline runner, and `diagnosis` instead of `mining`. Every changed file must appear in a skill diagnosis entry. The example abbreviates `results` to one regression pair.

```json submit-improve
{
  "schemaVersion": 1,
  "operationId": "d1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6",
  "candidateId": "42236cf7-acbb-441b-a6dc-94d4c73d980b",
  "expectedDigest": "ab94cc3036e46d1fc98d826f902ebbfdf25f39b58506726ca2106abf61900f41",
  "evidenceManifest": {
    "schemaVersion": 1,
    "candidateDigest": "ab94cc3036e46d1fc98d826f902ebbfdf25f39b58506726ca2106abf61900f41",
    "baseVersion": 1,
    "baseDigest": "8b833540f13f6a74442ca0256105c3f2931de70bed3dea2e55f3202a9d0aff14",
    "baselineKind": "revision",
    "policyDigest": "c9a5376f022601066f135fe4cc311ff5f21d6773aca2faf2f2d8f1b96dc2fb53",
    "suiteDigest": "1be6d4c1d44d7dac31ae15f2efd96c18280e78140ab051a0d032b78db47faae7",
    "holdoutIndex": 0,
    "authorExposed": false,
    "results": [
      {
        "baseline": {
          "runId": "run-reg-newsletters-base-0",
          "caseId": "reg-newsletters",
          "split": "regression",
          "repetition": 0,
          "inputDigest": "5d15fc6ae047ff48b1c5e9c92e6ba60973510466ebe4ca49f6b47a4a5a9d0208",
          "artifactDigest": "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
          "outcome": "pass",
          "hard": 1,
          "soft": 1,
          "verifierId": "zoho-checklist",
          "verifierVersion": "1",
          "timestamp": "2026-11-19T09:00:00.000Z",
          "producer": "examiner",
          "model": "your-model",
          "modelVersion": "your-model-version",
          "configuration": { "temperature": 0 },
          "tools": ["zoho_mail"],
          "environment": "zoho-sandbox",
          "budget": 100,
          "seed": null,
          "origin": "agent",
          "sessionId": "examiner-session-2",
          "isolated": true
        },
        "candidate": {
          "runId": "run-reg-newsletters-candidate-0",
          "caseId": "reg-newsletters",
          "split": "regression",
          "repetition": 0,
          "inputDigest": "5d15fc6ae047ff48b1c5e9c92e6ba60973510466ebe4ca49f6b47a4a5a9d0208",
          "artifactDigest": "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
          "outcome": "pass",
          "hard": 1,
          "soft": 1,
          "verifierId": "zoho-checklist",
          "verifierVersion": "1",
          "timestamp": "2026-11-19T09:01:00.000Z",
          "producer": "examiner",
          "model": "your-model",
          "modelVersion": "your-model-version",
          "configuration": { "temperature": 0 },
          "tools": ["zoho_mail"],
          "environment": "zoho-sandbox",
          "budget": 100,
          "seed": null,
          "origin": "agent",
          "sessionId": "examiner-session-2",
          "isolated": true
        }
      }
    ],
    "artifacts": {
      "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809": "<exact answer text>"
    }
  },
  "diagnosis": [
    {
      "evidenceIds": ["b02a5d98-ec76-49b5-8d9c-b3074539c140"],
      "cause": "The skill does not say to set fromAddress to the team alias",
      "category": "skill",
      "defect": "tool_usage",
      "files": ["SKILL.md"],
      "sections": ["Sending a reply"],
      "minimalChange": "For customer replies use fromAddress = sales@",
      "expectedTest": "The quote reply is sent from sales@"
    }
  ]
}
```

## restore

```json restore
{
  "schemaVersion": 1,
  "operationId": "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b",
  "skillId": "zoho-mail",
  "sourceVersion": 2,
  "expectedVersion": 3,
  "reason": "The folder rule also moved messages the user wanted to keep",
  "author": {
    "producer": "agent-cli",
    "model": "your-model",
    "modelVersion": "your-model-version"
  }
}
```

## sleep-run

One transcript per past session that used the skill. All transcript fields except `sessionId` and `project` are optional. `memory` is optional: include it with the exact current text of your memory file to allow memory proposals, or omit it and set `"config": {"evolve_memory": false}`.

```json sleep-run
{
  "schemaVersion": 1,
  "action": "run",
  "operationId": "f7a8b9c0-d1e2-4f3a-9b4c-5d6e7f8a9b0c",
  "author": {
    "producer": "agent-cli",
    "model": "your-model",
    "modelVersion": "your-model-version"
  },
  "skills": [{ "skillId": "zoho-mail", "expectedVersion": 2 }],
  "memory": {
    "label": "AGENTS.md",
    "text": "# Project notes\n\nGitHub notifications go to Dev/GitHub.\n"
  },
  "transcripts": [
    {
      "sessionId": "s-2026-11-20",
      "project": "/work/sales",
      "userPrompts": ["Move the GitHub notifications to the Dev folder"],
      "assistantFinals": ["Done: 14 messages moved"],
      "toolsUsed": ["zoho_mail.search", "zoho_mail.move"],
      "skillsUsed": ["zoho-mail"],
      "feedbackSignals": ["You left 3 in the inbox"]
    }
  ]
}
```

## sleep-resume

```json sleep-resume
{
  "schemaVersion": 1,
  "action": "resume",
  "sleepId": "8d4bb70b-9abd-4efd-98e9-8ef1b6679999"
}
```

## sleep-adopt

Send only after the user approved the staged proposal.

```json sleep-adopt
{
  "schemaVersion": 1,
  "action": "adopt",
  "operationId": "a9b0c1d2-e3f4-4a5b-8c6d-7e8f9a0b1c2d",
  "sleepId": "8d4bb70b-9abd-4efd-98e9-8ef1b6679999",
  "author": {
    "producer": "agent-cli",
    "model": "your-model",
    "modelVersion": "your-model-version"
  }
}
```
