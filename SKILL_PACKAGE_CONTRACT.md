# Anagenesis Skills — contratto tecnico del pacchetto npm per la gestione delle skill

Stato: specifica da implementare nel repository dedicato; nessuna integrazione è già disponibile.
Il progetto si chiama Anagenesis Skills; l'eseguibile `anagenesis` è affiancato da un'API TypeScript equivalente.
Repository suggerito: `anagenesis-skills`; nome npm candidato: `@<scope>/anagenesis-skills`, con scope e disponibilità ancora da verificare.
I termini DEVE e NON DEVE indicano requisiti verificabili.

## 1. Responsabilità e confini

Il pacchetto prepara il lavoro, conserva evidenze, verifica candidati e pubblica revisioni locali.
La CLI agente chiamante legge il brief e scrive o modifica `SKILL.md` nella sessione corrente, usando il proprio modello e il proprio login.
Il pacchetto NON DEVE chiamare API LLM, avviare agenti, chiedere credenziali di modelli o richiedere Python a runtime.
Il flusso NON DEVE dipendere da `/skill`, `$skill-creator`, comandi interattivi o riavvii dell'agente per scrivere.
Un eventuale rilevamento automatico delle skill da parte dell'host è esterno al contratto: la scrittura e la lettura esplicita del candidato funzionano subito.
I comandi `submit` e `restore` autorizzati dal chiamante pubblicano se passano le rispettive verifiche; non introducono una nuova approvazione umana.
Installazione npm e pubblicazione delle revisioni delle skill sono operazioni distinte; qui «pubblicazione» significa attivazione locale.

## 2. Riutilizzo Microsoft e principi SkillForge

Fonte Microsoft fissata: [SkillOpt v0.2.0, commit e4ea6a6771e797ef820cdd8bfea64c57e0481065](https://github.com/microsoft/SkillOpt/commit/e4ea6a6771e797ef820cdd8bfea64c57e0481065).
Componente verificato: [`skillopt_sleep/gate.py`, righe 12–46](https://github.com/microsoft/SkillOpt/blob/e4ea6a6771e797ef820cdd8bfea64c57e0481065/skillopt_sleep/gate.py#L12-L46).
Contiene `GateResult`, `select_gate_score` ed `evaluate_gate`: operazioni pure, senza modelli né motore di esecuzione.
Scelta vincolante: adattamento del codice in TypeScript, con attribuzione Microsoft; non semplice ispirazione e non importazione del motore Sleep.
Il port mantiene le metriche hard/soft/mixed, il peso mixed limitato a [0,1], il confronto strettamente maggiore e i tre esiti accept_new_best/accept/reject.
Un wrapper nostro rifiuta numeri non finiti e metriche fuori schema prima del port; questa restrizione non va attribuita a Microsoft.
La parità richiede fixture generate dall'originale fissato e confronto di tutti i campi restituiti, inclusi pareggi, peggioramenti, nuovo best e accettazione sotto il best.
Copertura aggiuntiva: peso sotto zero/sopra uno, metriche sconosciute, conservazione di best_step; Python è ammesso solo per produrre le fixture in sviluppo.
Il repository futuro conserva provenienza, SHA, originale di riferimento e [licenza MIT Microsoft](https://github.com/microsoft/SkillOpt/blob/e4ea6a6771e797ef820cdd8bfea64c57e0481065/LICENSE) nel materiale distribuito.
[`main/skillopt_sleep/gate.py`](https://github.com/microsoft/SkillOpt/blob/main/skillopt_sleep/gate.py) è stato consultato il 15 novembre 2026: il comportamento esposto coincide; il riferimento normativo resta lo SHA fissato.
Non si integra `cycle`, `backend`, `rollout`, mining LLM o scheduler: la release completa avvia attività estranee al ruolo di questo pacchetto.

Da [SkillForge, arXiv:2604.08618v2, §§2.4, 2.6–2.7 e appendice E](https://arxiv.org/html/2604.08618v2) si adottano principi, non codice: fonti ed esempi di dominio, diagnosi delle cause e modifiche circoscritte motivate dall'evidenza.
Il brief deve distinguere problemi della skill da errori di strumenti, dati, ambiente o esecuzione; questi ultimi non giustificano automaticamente una riscrittura.
Ogni modifica proposta collega evidenza, causa ipotizzata, sezione interessata e risultato atteso; la diagnosi rimane responsabilità dell'agente chiamante.

## 3. API e CLI non interattive

Tutte le richieste hanno `schemaVersion: 1`; gli input complessi provengono da file JSON o stdin e gli output sono JSON su stdout.
I log vanno su stderr, senza credenziali; ogni errore include `code`, `message`, `retryable` e dettagli strutturati.
Le mutazioni richiedono `operationId` UUID: stesso ID e stesso input restituiscono lo stesso risultato; input diverso produce `IDEMPOTENCY_CONFLICT`.
L'API espone `create`, `improve`, `submit`, `history`, `restore`, `recordFeedback`, `resolve`; ogni operazione riceve esplicitamente lo store.

| CLI | Input essenziale | Risultato |
| --- | --- | --- |
| `anagenesis create --request request.json` | skillId, obiettivo, fonti, esempi, policy valutativa | candidateId, briefPath, workspacePath, evaluationPlan |
| `anagenesis improve --request request.json` | skillId, expectedVersion, feedbackIds, obiettivo | candidato basato sulla revisione attiva e brief diagnostico |
| `anagenesis submit --request request.json` | candidateId, expectedDigest, evidenceManifest, operationId | published con versione/commit oppure rejected con motivi |
| `anagenesis history --skill ID` | skillId, eventuale cursore/limite | revisioni della sola skill, provenienza e motivi |
| `anagenesis restore --request request.json` | skillId, sourceVersion, expectedVersion, reason, operationId | pubblicazione diretta di vN+1 con contenuto storico esatto e restoredFrom |
| `anagenesis feedback --request request.json` | skillId, version, runId, osservazione e provenienza | feedbackId immutabile |
| `anagenesis resolve --skill ID` | skillId, eventuale version | percorso immutabile, digest, versione e commit |

Gli errori distinguono INVALID_INPUT, NOT_FOUND, ALREADY_EXISTS, STALE_BASE, EVIDENCE_INVALID, VALIDATION_FAILED, STORE_BUSY e STORE_CORRUPT.
Exit code: 0 successo, 2 input, 3 conflitto, 4 verifiche fallite, 5 I/O o integrità; nessun prompt su stdin.
`create` richiede skill assente, `improve` skill presente; entrambi possono produrre più candidati concorrenti senza prenotare versioni.
`expectedVersion` è obbligatorio per improve/restore; create registra base nulla e fallisce se un'altra creazione viene pubblicata prima.

## 4. Brief, candidato e contenuti

Il brief contiene obiettivo, limiti, destinatari, fonti con URI/revisione/digest, esempi di dominio e criteri di riuscita.
Include baseVersion/baseDigest, feedback selezionati, policy congelata, casi di sviluppo, istruzioni per valutare e formato del manifest dei risultati.
Per improve include diagnosi e piano da completare dall'agente: evidenceIds, causa, sezioni, intervento minimo e test atteso.
Il pacchetto può creare directory e metadati, ma il contenuto sostanziale di `SKILL.md` viene scritto dall'agente.
Il workspace candidato contiene `skill/SKILL.md`, eventuali `references/`, `assets/`, `scripts/` e un'area separata per brief/evidenze.
La skill pubblicabile è l'intero albero `skill/`; metadati del processo e risultati non vengono mescolati alle istruzioni.
I file sono UTF-8 dove testuali; il validatore controlla frontmatter name/description, riferimenti locali, limiti configurati e unicità degli identificativi.
Percorsi assoluti, traversal, symlink esterni e file speciali sono rifiutati; gli script allegati non vengono eseguiti implicitamente.
`candidateId` è un UUID, mai `vN`; stati: draft, rejected, published, stale. Una correzione dopo rifiuto resta senza numero.
Ogni submit congela uno snapshot e il relativo digest prima della verifica: modifiche successive al workspace non possono cambiare ciò che viene pubblicato.
Digest SHA-256 dell'albero su elenco ordinato di percorsi, tipo, modalità e digest dei byte; algoritmo e normalizzazione sono versionati.

## 5. Evidenze e valutazione senza orchestrazione di modelli

Per create la baseline è lo stesso compito senza la skill; per improve è la revisione attiva registrata nella base. Questa valutazione comparativa non si applica a restore.
Baseline e candidato usano stessi casi, strumenti, configurazione, budget e criteri; il modello/versione è dichiarato dal chiamante.
L'agente chiamante produce le esecuzioni e consegna risultati; può usare un harness già autorizzato, ma il pacchetto non avvia modelli né sessioni.
Un caso che richiede esecuzione isolata va eseguito da un harness del chiamante; l'assenza di isolamento va dichiarata e può rendere il confronto non valido.
La policy distingue development, validation holdout e regression suite; ID e digest dei tre insiemi sono congelati prima di modificare il candidato.
I casi usati per scrivere non entrano nel holdout; prompt, risposte attese e risultati dettagliati del holdout restano al valutatore esterno fino al submit.
Se l'agente autore li ha già visti, il manifest deve dichiararlo e il gate richiede un nuovo holdout; non è sufficiente chiamare «holdout» un file separato.
Il pacchetto verifica separazione degli ID/digest, copertura e dichiarazioni, ma non può certificare da solo la segretezza del contesto dell'agente.
Ogni tentativo consuma il proprio holdout: dopo un rifiuto, i casi rivelati diventano sviluppo e il nuovo tentativo richiede un set non esposto.
La policy definisce prima del lavoro numerosità minima, eventuali ripetizioni, aggregazione hard/soft, soglie assolute e tolleranze di regressione.
Nessuna soglia può essere ridotta nel submit; una nuova policy richiede nuovo candidato e nuova baseline comparabile.
Per create/improve il gate Microsoft confronta il punteggio candidato con quello della baseline, entrambi ricalcolati sul medesimo holdout.
Il best storico è confrontabile solo sotto identica evaluation fingerprint; altrimenti si inizializza dalla baseline, senza confrontare numeri di suite diverse.
Il miglioramento deve essere strettamente positivo, soddisfare le soglie assolute e non violare nessun vincolo della regression suite.
Per create/improve parità o peggioramento non pubblicano; restore verifica integrità, formato, provenienza e base attesa, senza richiedere miglioramento misurato né manifest valutativo.
Errori infrastrutturali producono evidenza incompleta, non successi né punteggi zero utilizzabili per favorire il candidato.
I controlli strutturali e il gate sono deterministici e locali; eventuali test deterministici sono comandi espliciti consentiti dalla policy, mai shell presa dalla skill.

Il manifest contiene candidateDigest, baseVersion/baseDigest, policyDigest, suiteDigest e per ogni caso baseline e candidato:
runId, caseId, split, inputDigest, output/artifactDigest, esito, hard/soft, verifierId/version, timestamp, producer, modello e configurazione dichiarati.
Include anche strumenti/ambiente, seed quando disponibile, origine machine/human/agent, sessionId non sensibile e attestazione di isolamento/esposizione.
Score derivati sono ricalcolati dai risultati verificabili; giudizi esterni restano attestazioni attribuite, mai «misurazioni indipendenti» inventate dal pacchetto.
Risultati mancanti, duplicati, riferiti a digest diversi o a una base obsoleta bloccano la pubblicazione.

## 6. Feedback e provenienza

Il feedback è append-only e riferisce skillId, versione realmente usata, artifactDigest, runId, producer, timestamp e fonte.
Contiene osservazione, risultato atteso/ottenuto, evidenceRefs, categoria e possibile causa; distingue fatto osservato e interpretazione dell'agente.
Se la versione non è nota, resta un segnale unassigned e non viene attribuito automaticamente alla versione attiva.
Una revisione registra feedbackIds, fonti, autore agente/modello dichiarati, ragione, diff e report delle verifiche; nessuna credenziale viene conservata.
Feedback tardivo su v1 resta associato a v1 anche se è attiva v2; l'agente decide e motiva se il problema persiste.
Correzioni di feedback aggiungono eventi che sostituiscono semanticamente l'evento errato senza cancellarne la provenienza.

## 7. Store locale, revisioni e restore

Configurazione esplicita: `storePath` assoluto fuori dal repository sorgente del pacchetto e dai workspace candidati.
Lo store possiede un repository Git locale dedicato, senza remoti; ogni operazione di scrittura verifica questa condizione e non esegue push/fetch/pull.
Un percorso risolto che ricade nel sorgente o ne riusa `.git` è rifiutato; il pacchetto non modifica index, branch o commit del repository chiamante.
Il runtime futuro inizializza lo store dedicato; questo contratto non crea repository né contiene implementazione.
Ogni skill ha una propria ref `refs/skills/<skillId>`: il commit di pubblicazione contiene snapshot completo, metadati e ricevuta di submit/restore della sola skill.
Il parent è l'ultima pubblicazione della medesima skill; history non dipende dal log globale di altre skill.
Gli oggetti Git e le revisioni sono immutabili; i workspace e gli eventi di feedback vivono in aree separate dello store.
`version` è un intero positivo visualizzato come v1, v2, v3; `skillId`, `candidateId`, commit e `restoredFrom` sono campi distinti.
La prima pubblicazione è v1; ogni pubblicazione successiva è esattamente ultimaVersione+1, indipendentemente dall'entità della modifica.
Bozze, test falliti, rifiuti e commit preparatori non raggiungibili dalla ref non consumano numeri pubblici.
Restore legge l'intera skill storica dallo store e pubblica direttamente dopo averne verificato integrità, formato, provenienza e base attesa; conserva sourceVersion/sourceDigest e reason obbligatorio.
Esempio: attiva v2, restore di v1 verificato e accettato → v3, `restoredFrom: v1`, parent v2, motivo separato; v1 e v2 restano nella storia.
Il contenuto restaurato mantiene lo stesso digest dell'originale; i metadati della nuova pubblicazione sono esterni all'albero della skill.
Nessun reset Git, rinomina retroattiva o modifica alle altre skill; restore non espone un candidato modificabile. Qualsiasi modifica al contenuto storico richiede il flusso improve.

## 8. Concorrenza, crash e attivazione

Lo store supporta un filesystem locale con lock e rename atomici; filesystem distribuiti non sono supportati senza un adattatore transazionale verificato.
Ogni submit/restore acquisisce un lock per skill e ricontrolla baseVersion/baseDigest; restore lega expectedVersion al commit attivo letto. Un lock conteso dà STORE_BUSY senza consumare versioni.
Il lock deve essere del sistema operativo e liberato alla morte del processo: non basta un file con timeout che possa scadere durante una scrittura valida.
Una base cambiata produce STALE_BASE: per submit servono nuovo candidato e nuova valutazione; per restore una nuova richiesta con base aggiornata e nuovo operationId, senza merge silenzioso.
Le verifiche costose possono precedere il lock sullo snapshot immutabile; sotto lock si ricontrollano digest, base, ricevute e policy.
Solo allora si calcola N+1, si scrive il commit con ricevuta operationId/inputDigest e si aggiorna la ref con compare-and-swap sul commit atteso.
L'aggiornamento atomico e durevole della ref è l'unico punto di pubblicazione: numero, contenuto e metadati diventano visibili insieme.
Oggetti e directory necessari sono sincronizzati su disco prima della ref; la configurazione Git deve garantire la durabilità richiesta sul filesystem supportato.
Un CAS fallito non pubblica il commit preparato e non riserva il suo numero; il retry rilegge lo stato e applica la verifica di base.
Crash prima della ref: nulla pubblicato; crash dopo la ref: revisione già pubblicata, recuperabile tramite ricevuta nel commit anche senza risposta al client.
I retry cercano operationId nella catena della skill, anche se nel frattempo esistono revisioni successive; non producono duplicati.
Le ricevute preparatorie di create/improve sono persistite atomicamente e riconciliate all'avvio; submit e restore condividono ricevute nel commit e CAS. Non esiste un contatore di versione separato dalla storia.
`resolve` legge una sola ref e restituisce uno snapshot materializzato immutabile: il lettore vede interamente la revisione vecchia o quella nuova.
La materializzazione usa directory temporanea e rename; una cache incompleta si rigenera da Git e non è fonte di verità.
Un'eventuale esportazione verso directory dell'host è una proiezione recuperabile con commit/digest; errori di esportazione non inventano nuove revisioni.
La raccolta degli oggetti orfani avviene solo quando non esistono operazioni in corso e non modifica la storia pubblicata.

## 9. Testo per il README futuro

> Questo pacchetto prepara e verifica revisioni di skill scritte dalla CLI agente chiamante, nella sua sessione e con il suo modello/login. Non invoca autonomamente modelli.
>
> È previsto un adattamento TypeScript delle funzioni pure `select_gate_score` ed `evaluate_gate` di Microsoft SkillOpt-Sleep v0.2.0, file `skillopt_sleep/gate.py`, commit `e4ea6a6771e797ef820cdd8bfea64c57e0481065`, con attribuzione e licenza MIT. Il motore Sleep non è incorporato. Stato attuale: specificato, non ancora implementato né validato per parità.
>
> Adottiamo da SkillForge, Liu et al., arXiv:2604.08618v2, i principi di radicamento nelle fonti di dominio, diagnosi delle cause e revisione circoscritta basata su evidenze; non ne riutilizziamo codice. Riferimenti: [Microsoft SkillOpt](https://github.com/microsoft/SkillOpt/tree/e4ea6a6771e797ef820cdd8bfea64c57e0481065) e [SkillForge](https://arxiv.org/html/2604.08618v2).
>
> Validazione degli input, regressioni, provenienza, versionamento e gestione transazionale sono responsabilità di questo progetto. Le esecuzioni e le attestazioni dei risultati provengono dal chiamante; il pacchetto non certifica autonomamente giudizi o isolamento. Non è un prodotto Microsoft né implica endorsement degli autori citati.

Dopo l'implementazione, sostituire la sola frase di stato con versione del port e risultati delle prove di parità realmente eseguite.

## 10. Criteri di accettazione

- Un agente completa create → scrittura del file → submit nella stessa sessione, senza login aggiuntivi, comandi speciali, riavvio o chiamate LLM del pacchetto.
- Il port Microsoft supera fixture di parità sullo SHA fissato; attribuzione e licenza sono incluse nel tarball npm.
- Create migliora la baseline senza skill; improve migliora quella attiva; pareggio, regressione o evidenza incompleta non pubblicano in questi due flussi.
- Holdout contaminato, metriche non finite, digest cambiato, baseline incompatibile e policy alterata producono errori verificabili.
- Feedback e storia mantengono versione e provenienza; history/restore di una skill non cambiano le altre.
- Due pubblicazioni concorrenti submit/restore sulla stessa base producono una sola nuova versione. L'altra riceve STALE_BASE quando può verificare la base, eventualmente dopo STORE_BUSY e un nuovo tentativo. Skill diverse possono pubblicare indipendentemente.
- Fault injection prima/dopo ogni fase di commit, ref e materializzazione dimostra assenza di buchi, collisioni, doppie pubblicazioni e snapshot parziali.
- Un retry dopo risposta persa ritrova la ricevuta; restore da v2 verso v1 pubblica direttamente v3 con contenuto esatto, motivo e restoredFrom, anche se la suite preferisce v2.
- Restore rifiuta contenuto corrotto, formato non valido, provenienza non verificabile o base obsoleta; non richiede miglioramento misurato né una nuova approvazione umana.
- Nessuna operazione muta il repository sorgente, configura remoti o effettua push; il README distingue adattamento Microsoft, principi SkillForge e componenti propri.
