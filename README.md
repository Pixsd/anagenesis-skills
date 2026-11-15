# Anagenesis Skills

Pacchetto TypeScript e CLI per preparare, verificare e pubblicare **revisioni locali di skill**. L'agente chiamante scrive `SKILL.md` nella propria sessione, con il proprio modello e login. Anagenesis conserva le evidenze e applica verifiche deterministiche; non chiama API LLM, non avvia agenti e non esegue gli script allegati alla skill.

Implementa il [contratto tecnico](SKILL_PACKAGE_CONTRACT.md). Pubblicare una revisione significa attivarla nello store locale, non pubblicare un pacchetto su npm.

## Avvio rapido

Requisiti: **Node.js 22+**, **Git 2.36+**, macOS o Linux, filesystem locale con `flock`, rename atomico e `fsync`. Il binding nativo `fs-ext` può richiedere compilatore C/C++ e Python durante `npm install`; **Python non è richiesto a runtime**, né per eseguire i test ordinari. NFS, SMB e filesystem distribuiti non sono supportati.

```sh
npm ci
npm test
npm run build
node dist/cli.js --help
node examples/workflow.mjs
```

L'esempio usa attestazioni sintetiche, crea uno store temporaneo fuori dal repository e stampa la revisione pubblicata. Non dimostra un miglioramento reale di un modello. Il percorso stampato permette di ispezionare lo store; la directory resta disponibile finché non viene rimossa esplicitamente.

Per installare il pacchetto localmente:

```sh
npm pack
npm install -g ./anagenesis-skills-0.1.0.tgz
anagenesis --help
```

Il nome `anagenesis-skills` è provvisorio: disponibilità e scope npm non sono verificati. Il pacchetto è `private: true` e `UNLICENSED` finché il proprietario non sceglie nome pubblico e licenza. Non è stata effettuata alcuna pubblicazione npm.

## Flusso dell'agente

1. Preparare una richiesta `create`, o `improve` con `expectedVersion` e i `feedbackIds` selezionati. Obiettivo, fonti, esempi, destinatari, limiti, criteri e policy sono espliciti.
2. Leggere il `briefPath` restituito. Scrivere o modificare `workspacePath/SKILL.md`, senza login aggiuntivi o riavvii. La creazione prepara la directory; non inventa il contenuto della skill. Improve copia l'intero albero della revisione base.
3. Far valutare baseline e candidato al proprio valutatore, sugli stessi casi e con impostazioni identiche. Il pacchetto non orchestra queste esecuzioni.
4. Calcolare il digest dell'albero e inviare `submit` con manifest ed evidenze. Un esito `published` contiene versione e commit; `rejected` contiene motivi e l'indice del prossimo holdout disponibile.
5. Usare `resolve` per leggere lo snapshot della revisione attiva o di una versione specifica.

Le richieste complete e la costruzione del manifest sono nell'[esempio eseguibile](examples/workflow.mjs); i tipi esportati e gli [schemi](src/schemas.ts) descrivono tutti i campi. Gli oggetti rifiutano proprietà sconosciute: non è possibile passare una policy alternativa a `submit`.

## API TypeScript

Ogni operazione riceve esplicitamente uno store. Si può passare `{ storePath }` o riutilizzare un'istanza `Store`, evitando la reinizializzazione tra chiamate.

```ts
import {
  Store,
  create,
  improve,
  submit,
  history,
  restore,
  recordFeedback,
  resolve,
  snapshotTree,
  type CreateRequest,
  type Manifest,
} from "anagenesis-skills";

const store = await Store.open({ storePath: "/absolute/path/skill-store" });
const candidate = await create(store, request satisfies CreateRequest);
// L'agente legge candidate.briefPath e scrive in candidate.workspacePath.
const { digest } = await snapshotTree(candidate.workspacePath);
const result = await submit(store, {
  schemaVersion: 1,
  operationId: crypto.randomUUID(),
  candidateId: candidate.candidateId,
  expectedDigest: digest,
  evidenceManifest: manifest satisfies Manifest,
});
```

`request` e `manifest` nell'estratto rappresentano gli input del chiamante; per un programma autonomo usare l'esempio completo. Tutte le operazioni sono asincrone. L'API espone errori `AnagenesisError` con `code`, `message`, `retryable`, `details` e `toJSON()`.

| Operazione       | Input specifico                                                           | Risultato                                          |
| ---------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| `create`         | skill assente, brief e policy                                             | UUID candidato, percorsi, base nulla, piano        |
| `improve`        | skill presente, `expectedVersion`, `feedbackIds`, brief e policy          | candidato dalla base fissata, brief diagnostico    |
| `submit`         | `candidateId`, `expectedDigest`, `evidenceManifest`, diagnosi per improve | `published` oppure `rejected`                      |
| `history`        | `skillId`, `cursor?`, `limit?` (default 20, massimo 100)                  | revisioni dalla più recente e `nextCursor`         |
| `restore`        | `skillId`, `sourceVersion`, `expectedVersion`, `reason`, `author`         | nuova revisione con contenuto storico esatto       |
| `recordFeedback` | versione/digest usati o entrambi `null`, osservazione e provenienza       | evento immutabile e `feedbackId`                   |
| `resolve`        | `skillId`, `version?`                                                     | percorso dello snapshot, digest, versione e commit |

Tutte le richieste hanno `schemaVersion: 1`; tutte le mutazioni richiedono `operationId` UUID. Riutilizzare **lo stesso ID e lo stesso input** dopo una risposta persa. Un input diverso con lo stesso ID produce `IDEMPOTENCY_CONFLICT`. I rifiuti sono anch'essi idempotenti: una correzione usa un nuovo ID e un holdout nuovo.

## CLI JSON, senza prompt

```sh
anagenesis create --store /absolute/path/skill-store --request create.json
anagenesis improve --store /absolute/path/skill-store --request improve.json
anagenesis submit --store /absolute/path/skill-store --request submit.json
anagenesis feedback --store /absolute/path/skill-store --request feedback.json
anagenesis restore --store /absolute/path/skill-store --request restore.json
anagenesis history --store /absolute/path/skill-store --skill demo-skill --limit 10
anagenesis resolve --store /absolute/path/skill-store --skill demo-skill --version 1
cat create.json | anagenesis create --store /absolute/path/skill-store --request -
```

Stdout contiene un singolo documento JSON; eventuali diagnostiche non devono essere mescolate ai risultati. Non ci sono richieste interattive su stdin. Il limite CLI per il JSON è 32 MiB.

| Exit code | Significato                                                          |
| --------- | -------------------------------------------------------------------- |
| 0         | Operazione riuscita                                                  |
| 2         | `INVALID_INPUT`                                                      |
| 3         | `ALREADY_EXISTS`, `STALE_BASE`, `STORE_BUSY`, `IDEMPOTENCY_CONFLICT` |
| 4         | `EVIDENCE_INVALID`, `VALIDATION_FAILED`, submit `rejected`           |
| 5         | `NOT_FOUND`, I/O, `STORE_CORRUPT`                                    |

Gli errori hanno forma `{"error":{"code":"…","message":"…","retryable":false,"details":{}}}`. `STORE_BUSY` è ripetibile con la stessa richiesta; `STALE_BASE` richiede un nuovo candidato/valutazione oppure una nuova richiesta restore con base aggiornata e nuovo ID.

## Policy ed evidenze

La policy congela prima della scrittura:

- casi di sviluppo con prompt e risultato atteso;
- uno o più holdout ordinati, descritti solo da ID, digest dell'input e requisito di isolamento;
- regression suite, ripetizioni, numerosità minima e aggregazione `mean`;
- metrica `hard`, `soft` o `mixed`, peso, soglie assolute e tolleranze di regressione;
- modello/versione, configurazione, strumenti, ambiente, budget e verificatore/versione;
- limiti di numero e dimensione dei file.

ID e digest degli input sono univoci fra tutti i set, inclusi gli holdout di tentativi futuri. Per create la baseline è senza skill; per improve è la revisione base. Il manifest contiene coppie baseline/candidato per ogni caso e ripetizione di holdout e regressione. Ogni esecuzione include identificativi, digest, esito, punteggi, timestamp, produttore, origine, sessione, seed nullable e isolamento dichiarato.

Gli artefatti sono stringhe UTF-8 in `artifacts`, indicizzate dal loro SHA-256: il pacchetto verifica i byte e ricalcola le medie. `hard` deve essere 1 per `pass`, 0 per `fail`; `soft` è in [0,1]. Esiti e giudizi del verificatore esterno restano **attestazioni attribuite**, non misurazioni indipendenti certificate da Anagenesis. Un `infrastructure_error` rende l'evidenza incompleta.

Il miglioramento sull'holdout deve essere strettamente positivo, superare le soglie assolute e rispettare ogni vincolo di regressione per caso/ripetizione. Il best storico si confronta solo sotto identica fingerprint di policy e suite. Un pareggio non pubblica.

Il valutatore esterno conserva prompt, risposte attese e risultati dettagliati del holdout fino al submit. `authorExposed: true` blocca la pubblicazione; il pacchetto verifica dichiarazioni e separazione, ma non può certificare cosa abbia visto l'agente. Ogni tentativo che congela uno snapshot consuma il holdout anche se fallisce. Si prosegue con l'indice successivo già congelato, senza ridurre soglie; esauriti i set, serve un nuovo candidato e una nuova baseline comparabile. I casi consumati non possono tornare holdout per la stessa skill e vengono elencati come sviluppo nei brief successivi.

Improve richiede una diagnosi collegata a feedback, casi di sviluppo o URI delle fonti: `evidenceIds`, `cause`, `category`, `sections`, `minimalChange`, `expectedTest`. Deve esserci una causa attribuita alla skill. Errori di strumenti, dati, ambiente o esecuzione non giustificano da soli una riscrittura.

## Skill, digest e feedback

Lo snapshot pubblicabile è tutto `skill/`, inclusi riferimenti, asset, script e directory vuote. Brief, manifest e metadati vivono fuori dall'albero. `SKILL.md` richiede frontmatter YAML con `name` uguale allo `skillId`, `description` non vuota e un corpo non vuoto. Lo skill ID usa lettere ASCII minuscole, cifre e trattini, massimo 64 caratteri.

Il validatore controlla UTF-8 per i formati testuali riconosciuti, collegamenti Markdown locali inline e reference-style, dimensioni, nomi duplicati o in collisione maiuscolo/minuscolo. Rifiuta percorsi assoluti, traversal, `.git`, file speciali e **tutti i symlink**, anche interni. Gli script sono conservati come file, senza eseguirli.

Algoritmo `anagenesis-tree-v1`: percorsi POSIX NFC ordinati per byte UTF-8; JSON canonico con chiavi ordinate, `algorithm` e `entries`. Ogni entry contiene percorso, tipo, modalità normalizzata (`100644`, `100755`, `040000`) e SHA-256 dei byte; per directory il digest è quello della stringa vuota. Il digest finale è SHA-256 di quel JSON. Timestamp, proprietario e permessi di scrittura non entrano nel digest; i byte dei file non sono normalizzati.

Il feedback è append-only. Un feedback tardivo sulla v1 resta sulla v1 anche se è attiva v2. Una versione sconosciuta usa `version: null`, `artifactDigest: null` e resta `unassigned`. `supersedes` aggiunge una correzione senza cancellare l'evento originale. Osservazione, atteso/ottenuto e possibile causa restano distinti. Non inserire credenziali nei brief, nelle configurazioni o nelle evidenze.

## Store, concorrenza e restore

`storePath` deve essere assoluto, fuori dal repository del pacchetto, da qualsiasi altro checkout Git e dagli store/workspace candidati. I percorsi vengono risolti anche attraverso symlink. Lo store contiene un repository **bare dedicato, senza remoti**, e non usa index o branch del chiamante. Le variabili Git ereditate vengono escluse; non ci sono comandi push, pull o fetch.

```text
store/
  anagenesis-store.json
  repo.git/           # unica fonte di verità per le pubblicazioni
  operations/         # ricevute e intenti idempotenti
  candidates/         # metadati separati dai file dell'agente
  workspaces/<uuid>/  # brief.json e skill/
  attempts/           # snapshot congelati e holdout consumati
  feedback/           # eventi append-only
  locks/              # file persistenti; lock effettivi nel kernel
  cache/<commit>/     # materializzazioni in sola lettura, ricostruibili
```

Ogni skill usa `refs/skills/<skillId>`. Il commit contiene l'intero albero, provenienza, diff, report e ricevuta; il parent è la pubblicazione precedente della stessa skill. Non esiste un contatore separato: v1, v2, v3 sono assegnate solo all'aggiornamento atomico della ref mediante compare-and-swap. Git usa `core.fsync=all` e `core.fsyncMethod=fsync`.

I lock `flock` sono non bloccanti, separati per operazione e skill, e vengono rilasciati dal kernel alla morte del processo. Per semplicità le verifiche di submit rimangono sotto il lock della skill: skill diverse possono avanzare indipendentemente, una seconda mutazione della stessa skill riceve `STORE_BUSY`. Un conflitto CAS/base non riserva una versione.

Crash prima della ref: nessuna pubblicazione. Crash dopo la ref: la ricevuta nel commit permette di recuperare il risultato, anche dopo pubblicazioni successive. Snapshot del tentativo e preparazioni sono riconciliati al retry. `resolve` fissa una ref e materializza da Git tramite directory temporanea e rename; una cache incompleta/corrotta viene ricostruita. I percorsi restituiti sono in sola lettura; non modificarli. La protezione non impedisce al proprietario del filesystem di manomettere lo store.

Restore non crea un candidato modificabile e non richiede un manifest valutativo: verifica contenuto, formato, provenienza e base attesa. Con v2 attiva, restore di v1 pubblica **v3**, con parent v2, `restoredFrom: 1`, `sourceDigest` e motivo. Il digest della skill coincide esattamente con v1, anche quando la valutazione preferiva v2. Per cambiare i contenuti storici si usa improve.

Questa versione non offre esportazione verso directory host né garbage collection automatica: cache in quarantena, snapshot e oggetti orfani possono occupare spazio. Le prove di crash simulano la morte del processo, non un guasto fisico del disco; la durabilità dipende dalle garanzie del filesystem e dell'hardware supportati.

## Test, manutenzione e dimensioni

```sh
npm run check          # formato, compilazione strict, test Node
npm run test:coverage  # copertura nativa Node
npm run fixtures      # solo sviluppo: rigenera fixture con Python 3
npm pack --dry-run    # verifica i file distribuiti
```

I test usano `node:test`, store temporanei e processi reali. Coprono parità Microsoft, create/improve/restore, feedback, rifiuti, input/evidenze alterati, digest, asset e modalità eseguibili, isolamento dallo store sorgente, concorrenza fra processi, rilascio dei lock dopo `SIGKILL`, recupero di ricevute e materializzazioni. La CI configura Node 22/24 su Linux e macOS. Non occorrono modelli, credenziali o servizi esterni per i test.

Tre dipendenze runtime: `fs-ext` per i lock di sistema, `yaml` per il frontmatter e `zod` per gli schemi. Nessun framework CLI, database, server o runtime Python. TypeScript, tipi e Prettier sono solo dipendenze di sviluppo.

## Attribuzioni

Il port TypeScript delle funzioni pure `select_gate_score` ed `evaluate_gate` deriva da **Microsoft SkillOpt-Sleep v0.2.0**, commit [`e4ea6a6771e797ef820cdd8bfea64c57e0481065`](https://github.com/microsoft/SkillOpt/tree/e4ea6a6771e797ef820cdd8bfea64c57e0481065). Stato: **port v1 implementato; 108 fixture di parità generate dall'originale e verificate su tutti i campi**, inclusi pareggi, peggioramenti, nuovo best, accettazione sotto il best e clamp del peso. Il motore Sleep non è incorporato. Originale, SHA nelle fixture e licenza MIT Microsoft sono inclusi nel tarball.

Da [SkillForge, Liu et al., arXiv:2604.08618v2](https://arxiv.org/html/2604.08618v2), §§2.4, 2.6–2.7 e appendice E, adottiamo fonti ed esempi di dominio, diagnosi delle cause e modifiche circoscritte basate su evidenze; non riutilizziamo codice.

Validazione, regressioni, provenienza, versionamento e transazioni sono responsabilità di questo progetto. Le esecuzioni e le attestazioni provengono dal chiamante; il pacchetto non certifica autonomamente giudizi o isolamento. Non è un prodotto Microsoft né implica endorsement degli autori citati. Dettagli in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
