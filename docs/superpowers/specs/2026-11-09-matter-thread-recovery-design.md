# Voice-guided Matter/Thread setup recovery — proposed design

**Status: proposal for review, not approved for implementation.** Date: 2026-11-09. Working label: **Setup Relay**; naming is not a product decision. Research: [evidence register](../research/2026-11-09-matter-thread-evidence.md). Conditional implementation tasks: [plan](../plans/2026-11-09-matter-thread-recovery.md).

The workspace was empty when inspected, is not a Git repository, and contains no applicable `AGENTS.md` or project instructions. Only planning documents are being created. The user's latest inventory answer establishes public information as available; it establishes **no physical accessory, phone, hub, home network, export, account or privileged API**.

## 1. Product thesis and decision basis

**First user, proposed:** a hands-on Home Assistant user trying to add one Matter-over-Thread plug or bulb, who has reached a named setup error and is moving between the accessory, their phone and hub. They can read the product label and app messages but do not know which prerequisite or network layer the failure concerns. This is a narrow initial audience chosen for documented procedures and inspectable state, not a claim that the user owns Home Assistant.

**Recent trigger and pain:** growing mixed-ecosystem Thread installations have prompted new diagnostic products in 2026, while firsthand commissioning reports still describe prolonged, repeated attempts [R03–R06]. These sources justify investigating the workflow; they do not establish frequency, market size, willingness to pay, or that current alternatives fail every time.

**Useful output:** one source-backed, applicable next check, with what the person should observe afterward; a record of actual attempts; and either a verified outcome or a concise support packet identifying evidence gaps. An unsuccessful repair can still yield a useful packet. A plausible explanation without a check or handoff is insufficient.

**Why voice might help:** hands and attention are occupied while inspecting labels, moving equipment, or following a phone UI. Spoken corrections and “already tried that” should update a durable case rather than restart a generic conversation. Exact identifiers remain visible/editable, and text interaction is always available. Voice preference and reduced cognitive load are hypotheses to test, not established accessibility or usability gains.

**Specific gap to validate:** guide the *commissioning attempt* across physical actions and platform instructions before successful pairing, maintain a typed evidence/attempt record, revise only affected advice when the setup changes, and hand off an accurate case. Thread Doctor already supplies native snapshots, history, export and AI analysis [R06]. This product must complement available tools and earn its place through better task completion, not “AI on Thread diagnostics,” a mesh visualization, or generic chat over manuals.

**Event goal:** attendees can try a useful case and inspect its engineering afterward, creating grounds for engineering conversations and possible introductions. Winning is secondary. No employment, conversion or benchmark claims are promised.

## 2. Three narrow approaches and recommendation

| Approach | Gain | Cost / who bears it | Feasibility and differentiation |
|---|---|---|---|
| **A. Failed commissioning → next check + support packet** | Useful before native diagnostics exists; small supported decision graph; voice fits physical work | User must report observations accurately; builder must curate precise applicability and avoid generic advice | Best public-information demo. Recommend A, with HA as the initial controller and one accessory family. Requires validation against simply following the official guide. |
| **B. Already-paired but unavailable → diagnostic-guided review** | Can inspect measured snapshots and compare before/after | User needs a supported native collector/export, permissions, reachable devices and possibly paid features; builder needs schema/redaction adapters | Strong follow-on if real exports become available. More direct competition with Thread Doctor; snapshot causality remains limited. |
| **C. Setup readiness before first pairing** | Deterministic prerequisite checks can catch wrong hub/phone/app/protocol | User must identify hardware; weaker recovery narrative and fewer real observations | Smallest truthful event fallback, but highest risk of becoming an FAQ checklist. |

**Recommendation is not selection.** A is the author’s proposed default. User selection and design approval are pending. The user explicitly asked for reviewable documents now, so this proposal and its conditional task plan are written before that selection; no execution can infer approval from them. B is stretch, C is a fallback scope reduction, and none entails a universal smart-home repair agent.

## 3. Scope and support policy

### MVP after approval

- Browser voice/text companion alongside the existing commissioning app. The assistant does not commission an accessory itself.
- One session/case, one accessory and commissioning phone at a time. Support Android and iPhone *instruction branches*, even when the live demo can test only one or neither.
- Initial reviewed corpus: HA Matter/Thread instructions plus Eve US/Canada Energy identity data; exact device-specific destructive procedures are excluded. The reviewed identity fixture is product **10EBU4151**, model **20EBU4101**, explicitly a synthetic case based on R12. It is not owned/tested hardware.
- Recognize five stages: `prerequisite`, `discovery`, `commissioning`, `connectivity-check`, `post-pair-unavailable`; unknown is valid. Route the last stage to evidence collection/handoff in MVP, not a mesh diagnosis.
- Guided prerequisites, platform-specific credential-sync guidance when topology permits, one controlled retry, attempt retention, correction handling, source cards and downloadable Markdown/JSON case summary.
- Dynamic Exa retrieval can discover/update evidence. Only reviewed, version-scoped rules can issue operational instructions. Unreviewed search results can support a reading link or documented hypothesis, never silently create a new repair procedure.
- Case ends as `next-check`, `user-reported-recovered`, `observed-recovered`, `unresolved`, or `unsupported`. No generic “fixed” state.

### Stretch

One validated export adapter; user-approved before/after snapshot comparison; additional exact accessory family; resumable local case; offline source-pack fallback; optional asynchronous research of redacted public-model issues. Each needs its own coverage and rights review.

### Excluded

Universal device support; native iOS/Android collector; credential reads/migration; network scans from the browser; automatic configuration or control; firmware flashing/OTA; router/VLAN/firewall edits; factory resets; buying equipment; account setup; support calls/tickets/emails; remote technician access; locks, alarms and other consequential device-control demos. No model receives setup codes, passwords, operational datasets or private log dumps.

Unknown firmware is **not** proof of incompatibility. Allow version-independent, reversible checks when all their own prerequisites are known; withhold firmware-specific advice. Explicitly unsupported protocol/hardware/deployment combinations become an unsupported outcome. A missing API becomes `evidence-unavailable`, not “no fault.”

## 4. User experience and concrete journeys

The proposed interface has a start/stop control, captions/text input, editable setup facts, **one next check**, a “what happened” response, source links, and an attempt timeline. End with “save case summary.” Keep the engineering event trace in a separate opt-in reviewer view. No UI is implemented or visually approved.

Voice asks one relevant question at a time. Do not front-load every version field. Start with controller, phone, accessory identity and failure stage; request a version only when a candidate check depends on it. Show `unknown` rather than invent a default. A number or QR label should be typed/read from a restricted identity field, never guessed from phonetic similarity.

### Journey 1 — first HA Thread network, commissioning fails

**Grounding:** R01–R02 document commissioning and phone credential prerequisites. **Test status:** synthetic workflow; no successful home setup has been observed.

1. Person says an Energy plug will not pair. Ask new/already-in-use, controller, commissioning phone and exact error. Confirm exact product/region/protocol from its label, not just “Eve plug.” Unknown identity means generic read-only intake only.
2. In the proposed fixture, facts are explicitly seeded: new Matter product 10EBU4151/20EBU4101, Android with full Companion/Google services, HAOS and a Thread-configured ZBT-2, newly created HA Thread network, no other TBRs reported, failure at connectivity check. Installed firmware versions are unknown. These facts are fixture inputs, not public network measurements.
3. Confirm the border router is reported present and whether this phone completed the relevant sync. Distinguish `not done`, `reported done`, `failed`, and `unknown`. If already attempted, do not repeat without new justification.
4. When that branch applies, offer the documented Android Companion sync path, then ask what success/error message appears. Credentials stay entirely inside the native app; the assistant wants only success/failure, not their contents. [R02]
5. Log the observed message as **user report**, then propose one pairing retry in the native app. If it succeeds, ask the person to operate the accessory in the controller and report the physical result. Record `user-reported-recovered`, never independently verified recovery.
6. If retry fails, preserve the attempt and exact error. Provide an applicable next check if evidence supports one; otherwise produce the packet rather than looping through resets.

**Useful result:** the person knows whether phone credential synchronization was attempted, has an applicable instruction and expected observation, and retains a failed attempt for support. “Credential mismatch caused it” remains unproved unless stronger evidence exists.

### Journey 2 — consequential correction while work is pending

**Grounding:** Android and iPhone sync paths differ in R02. **Test status:** synthetic correction case; voice and retrieval must later be tested live.

The person begins, “I'm pairing on my iPhone,” then says, “Actually I'm using my Android tablet.” The app revises `phone.platform`, invalidates the pending iPhone *instruction*, and preserves the exact accessory identity, manufacturer source, and prior power check. It checks Android-specific prerequisites before proposing that branch. It does not change the device's intrinsic specs or claim the tablet has Google services.

The alternative, “Would using an Android tablet help?” is a hypothetical: retain iPhone as the actual phone, answer within a separate hypothetical context or clarify, and do not replace facts. “Actually not the tablet, back to the iPhone” creates another revision; a late Android judgment or lookup must not win.

**Useful result:** current-phone instructions, unchanged independent evidence, and a visible explanation that the earlier phone-specific step no longer applies. If correction arrives after speech starts, interrupt/retract that step; audio already heard cannot be erased.

### Journey 3 — genuine prerequisite blocker, no imaginary repair

**Grounding:** Apple documents third-generation Apple TV model differences [R11]. **Test status:** curated readiness fixture; not evidence of the attendee’s inventory.

Person reports “Apple TV 4K” as the only hub. Ask generation and variant. If they confirm third-generation **64 GB Wi-Fi** and no other TBR, show that this reported hub variant does not supply the documented Thread capability. Do not claim a network scan found no TBR. Outcome: `unsupported-current-setup`, with a request to verify any other available compatible border router; no automatic shopping recommendation or claim that more resets will help. If another TBR exists, reassess instead of retaining the blocker.

### Journey 4 — unknown firmware, unavailable diagnostic access, unresolved

**Grounding:** R06/R08/R13 describe access boundaries; R09 is inaccessible. **Test status:** synthetic unsupported/unresolved case.

Person has a paired-but-unavailable device, unknown firmware, and cannot obtain a supported export. The app records physical power check and error reports, says it cannot inspect mesh health, and offers collection instructions or a manual handoff. An exporter/API permission error is recorded as unavailable evidence. A search hit about stale preferred networks is not treated as a confirmed platform defect. Stop after two unsuccessful *distinct* guided checks in a case and offer handoff; the user can explicitly continue with a newly justified check. Repeating a contradicted or failed check needs an explained reason.

**Useful result:** a support packet with model/firmware unknowns, last known working time if reported, attempted checks and outcomes, current evidence boundary, and the next question for a support engineer. Platform-blocked means a **documented capability boundary in the current configuration**, not a speculative claim that the platform can never be fixed.

### 75-second demo script

| Time | Attendee action / visible result | Provenance |
|---|---|---|
| 0–10 s | Start a clearly labeled “example failed setup”; confirm controller/accessory facts | Seeded synthetic household; sourced device identity |
| 10–25 s | Speak the failure and initial iPhone context; a genuine partial should start bounded documentation work | Live voice/retrieval only after integration tests pass; otherwise labeled replay |
| 25–40 s | Correct to Android; current phone changes, an old iPhone result is visibly rejected | Live state engine; delayed race may be a labeled test fixture |
| 40–60 s | Confirm the branch prerequisites; receive one Android-app check and its expected observation | Curated source rule; Exa live refresh optional and labeled |
| 60–75 s | Report “I already tried that and it failed”; show retained attempt and a ready-to-download unresolved packet | User-reported fixture action; no physical fix claimed |

Do not squeeze a real reset/recommission cycle into 75 seconds. If hardware is acquired later, demonstrate a rehearsed, reversible failure and show real before/after task evidence; disclose any staged condition. The inspectable result is useful even in an unresolved demo.

## 5. Sponsor use cases and boundaries

All integrations below are **proposed and untested**. “Core” identifies the intended complete voice MVP, not an event requirement. A missing provider has an explicit scope reduction, never an unlabeled simulator.

| Sponsor / classification | Actual user action → proposed use | Boundary / prerequisites | Success criterion and fallback |
|---|---|---|---|
| **Vapi — core voice transport** | Attendee speaks while holding equipment; transcript and interruption events reach the session; approved response text returns as speech | Web SDK + configured assistant; authenticated server event delivery and custom response endpoint; mic permission, HTTPS/localhost and account access [S01–S03] | One session can deliver a real partial, correction and spoken current step with traceable binding. If binding/response control fails, use text/replay and disclose loss of live voice. No telephone number or PSTN required. |
| **Deepgram — core via Vapi** | Recognize “ZBT-2,” “Eve Energy,” spelled identifiers and a mid-sentence phone correction; synthesize the short check | One microphone stream through Vapi; proposed Nova-3 and available Deepgram TTS voice [S04–S05]. Use account-supported configuration. No second raw Flux listener | Live recording/event capture shows actual provider and partial/final behavior; uncertain identifiers trigger confirmation. If recognition fails, typed identity/text input; don't advertise a second parallel audio pipeline. |
| **Exa — core retrieval provider in full MVP; optional live refresh in event slice** | Person names a product/error; fetch exact vendor/platform guidance and recent issue evidence | Backend key, official domain/path filters, source model/region/version/date validation, rights-aware storage [S06] | Each issued check has eligible current source evidence. Irrelevant variant, inaccessible page or conflicting advice yields abstention/curated source pack. Retrieval relevance never proves the household diagnosis. |
| **TypeSafe/Jev — proposed core semantic adapter; removable** | Person corrects the current phone or asks a hypothetical; classify utterance relationship, stage, readiness or whether a specific step was completed | Backend key; official skill read now and re-read before integration; current SDK is `@typesafe-ai/sdk`, Node 22+ [S07]. Typed candidates, bounded state, batched independent questions | Held-out corrections and hypotheticals follow the truth table; unknown/error asks clarification. Exact identity, dependencies and actions are code-owned. No access → explicit structured confirmation controls, no claimed live Jev. |
| **Manus — optional build-time research; runtime unjustified for MVP** | After a case reveals a public model/firmware gap, a developer researches vendor release/support pages into a citation checklist | API v2 or supported app access, budget, public inputs only, read-only task scope; human audit [S08]. No support contacts or autonomous configuration | Produce an auditable source/update diff that a maintainer approves; no unsupported live fix claim. Not in the 75-second request path. No useful budget/access → omit. |
| **AdaL — optional build-time demo production; runtime unjustified** | Later turn an approved sanitized screen recording into a captioned event demo or product explainer | Compatible environment, account/credits, rights to footage/assets; official capability verification [S09]. Windows workflow not established | Export a truthful clip preserving live/fixture labels and readable useful output, without invented device footage. No compatible access → ordinary screen recording. No diagnostic or decision role justified. |

End-to-end sponsor chain for Journey 2: Vapi/Deepgram receive the phone correction → Jev proposes its semantic meaning → code changes only the accepted facts/dependents → Exa or the curated pack provides current applicable guidance → code chooses and renders a check → Vapi/Deepgram speak it → the user’s result enters the attempt record. Manus can later help a maintainer research an unresolved public issue; AdaL can later explain the already-recorded demonstration. Neither is forced into runtime.

**Unsponsored essentials:** Node 22+ runtime and package manager; TypeScript service with a tiny web client; in-memory session store; source/rule pack; tests and event trace; HTTPS host or authenticated tunnel with SSE support; browser microphone/speakers or headset; cloud connectivity; applicable provider keys/billing. Deterministic response templates mean no separate general-purpose dialogue LLM is required for the narrow flow. If later added, name its provider/data path/cost explicitly. Diagnostic tools and real hardware are separate prerequisites, not sponsor APIs.

## 6. Architecture and event flow

Proposed stack is a small Node 22+/TypeScript service, ordinary browser client, Vapi Web SDK, Deepgram via Vapi, Exa HTTP API and Jev SDK. No existing stack constrains the choice. Avoid a framework/database/native app until the session engine proves useful.

Flow: **microphone → Vapi/Deepgram → authenticated event adapter → versioned case reducer → bounded retrieval + semantic judgments → source/rule eligibility → next check → response gate → Vapi TTS**, with a separate browser view of current facts, attempts and the result.

1. User starts a case and consents to cloud audio processing. Browser receives a session capability; server establishes a distinct voice binding. Voice begins only after a user gesture.
2. Bind transcript webhooks and custom response requests to the same session/epoch using authenticated Vapi call identity or a server-configured per-session response route. **Never bind by transcript similarity or “latest active session.”** Account/request capabilities are an early probe, not an assumed implemented route. Browser public-key requests must not supply arbitrary custom model URLs [S03].
3. Normalize only documented events. One authoritative transcript ingress (server) mutates case state; browser captions are display-only. Assistant speech is never parsed as user facts. Final text reconciles partials; partials are revisions, not append-only truth.
4. A stable partial means a complete candidate field span appears unchanged in **two consecutive received partial hypotheses**. This is an author-proposed scheduling rule, not an ASR accuracy guarantee. Start only bounded, read-only documentation work. First partial may update captions; it cannot trigger operational advice. Final input may proceed without a second partial. Stable does not mean confirmed.
5. Preserve candidate spans; code finds exact known identifiers/aliases. Semantic judgments propose assertion/correction/hypothetical and stage. Do not infer factual phone/hub inventory from a question. Partial candidate data never overwrites confirmed facts.
6. Final input and explicit confirmation reconcile the canonical facts. A likely correction immediately suppresses dependent queued advice while confirmation is pending; it must not continue the old recommendation just because ambiguity remains. Tentative work may continue in quarantine.
7. Fetch at most **two** external documentation requests concurrently, one active semantic batch, and keep only the newest pending hypothesis. At most **four** documentation dispatches per utterance; coalesce repeated candidates. No model calls or external writes are triggered by hypothetical repair suggestions. A final correction can schedule the next utterance's work; budget exhaustion yields pending/clarification, not a wrong cached answer.
8. Validate result provenance and dependency versions at **acceptance**. Valid raw manufacturer evidence can be retained independently of a phone-specific derived instruction. A global revision mismatch alone must not discard unrelated sources.
9. At final response construction, require current confirmed inputs for the selected step, reviewed rule evidence, unambiguous identity where required, and no unresolved conflict. Recheck dependency stamps and transcript/response epoch **immediately before emission**. Use short deterministic templates; no arbitrary LLM stream can issue repair instructions.
10. Hold complete advice until checked; emit short response units. Before each unit/chunk recheck the response epoch. On any new user speech/correction, invalidate queued units and use Vapi interruption behavior. Nothing can retract audio already delivered: acknowledge the superseded step and issue corrected guidance. A prompt-only “ignore stale advice” is not this guarantee.
11. If retrieval isn't ready at the response boundary, say the check is pending and display that state. Do not promise an automatic later spoken callback. User asks “what now?” or selects refresh; the new response reads current state. Asynchronous unsolicited speech requires separately verified control support.
12. On reset/end/expiry, revoke binding, increment epoch, cancel work best-effort and reject all late results. Cancellation saves work; eligibility checks establish correctness.

## 7. State, evidence and action contracts

These are proposed application contracts, not assumed sponsor payload formats.

| Record | Required content and invariant |
|---|---|
| `CaseState` | `sessionId`, `epoch`, monotonic `revision`, `transcriptRevision`, `responseEpoch`, facts map, observations, attempts, sources, derived results, pending conflicts and outcome. |
| `Fact` | Typed field path/value, field version, status `candidate/confirmed/disputed/unknown`, origin `fixture/user-report/import`, supporting event/span. “Confirmed” means the user confirmed the report or an eligible import observed it; it does not mean independently true. |
| `SetupFacts` | Accessory vendor/product/model/region/protocol/firmware; controller/deployment/version; phone platform/OS/app/build/Google-services state; hub inventory/model/firmware/Thread-role; topology summary; new/already-paired; failure stage/error. Store only fields needed for the branch. |
| `Observation` | Subject, predicate/value, collection method, timestamp, evidence ID, scope and missing-data reason. `user-report` stays distinct from `import-observation`. Unknown is not false. |
| `SourceEvidence` | URL, publisher, title, fetched time, publication/update date or unknown, content hash, brief supporting passage/reference, model/region/version scope, `official/community`, `live/curated`, access status and rights note. No source date inferred from fetch time. |
| `DependencyStamp` | `sessionId`, `epoch`, exact field-version map plus rule/source/observation versions. Judgments also carry transcript revision/span. Every dependent read must be declared. |
| `WorkItem` | ID, kind, candidate hypothesis, dependency stamp, status, timestamps, cancellation token and provenance mode. Quarantined partial work cannot create an action. |
| `Attempt` | Stable ID, step/rule version, timestamp, outcome `not-started/in-progress/succeeded/failed/skipped/unknown`, evidence IDs, and snapshot of applicable facts. Append revisions/corrections; never erase the physical history. Mark a phone-specific old attempt no-longer-applicable without pretending it never happened. |
| `Check` | ID, required facts, predicate, source IDs, reversible action text, expected observation, risk/stop conditions, attempt dedupe key and dependency stamp. Code selects only reviewed checks. |
| `CaseSummary` | Current setup + unknowns, observations labeled by method, hypotheses, attempted steps/outcomes, eligible next check or stop reason, source URLs/freshness, unresolved questions, provenance mode and recovery verification level. Download only; never send automatically. |

### Correction and dependency rules

| Changed field | Invalidate/recheck | Preserve independently |
|---|---|---|
| Phone platform/OS/app/services | Phone prerequisites, sync/menu instructions and commissioning branch | Exact accessory specifications, general manufacturer source, prior power observation |
| Accessory product/model/region/protocol/firmware | Identity/protocol compatibility, relevant model/firmware guidance and version-specific conclusions | Controller documentation and physical history; re-scope attempts rather than delete |
| Hub identity/firmware/Thread role/inventory | Border-router prerequisites and topology-dependent checks | Phone identity, accessory documents |
| Network/topology or ownership changes | Credential/network hypotheses, network-specific observations requiring a fresh capture | Independent product facts and completed attempt history |
| Failure stage or new/already-paired | Next check and diagnostic collection route | Compatible facts, source records and past attempts |
| Source content/rule update | Conclusions/actions citing the old source/rule | Unrelated source evidence and observations |

Field versions are monotonic even for `iPhone → Android → iPhone`; matching text again does not resurrect an old task. A result with no declared dependencies is ineligible. The dependency list comes from the code-owned work/rule definition, not a model's self-report. Independent parts of one multi-purpose fetch must be stored separately before reuse.

Explicit typed edits take precedence over an unconfirmed voice proposal. If voice contradicts a typed confirmed value, mark a conflict and ask to replace it; do not silently choose whichever arrived last. For repeated/contradictory corrections, withhold dependent advice until the current value is explicitly resolved. A hypothetical gets a separate hypothetical context and cannot mutate canonical setup.

### Code versus model versus physical evidence

| Owner | Establishes | Does not establish |
|---|---|---|
| **Code** | Exact identifier matching, constraints from reviewed rules, versions, session binding, eligibility, dependency invalidation, source scope, attempt history and response templates | Real radio conditions, hidden credentials, platform health, or truth of an unsupported user report |
| **Jev / optional semantic model** | Bounded proposals about meaning: current correction vs hypothetical; which stated stage; whether an utterance reports completing a named check | New identifiers, firmware compatibility, source authority, action eligibility, diagnosis, consent to destructive change |
| **Exa** | Retrieved public content and retrieval metadata | Whether the household matches it, whether advice is correct/current enough, or whether a symptom has that cause |
| **Person / eligible native collector** | Reported physical observation or timestamped attributes actually read with the collector's scope | Universal mesh visibility, unavailable accessory state, causality from one snapshot, proof a closed platform defect was fixed |

Jev question module batches independent questions over the same small state: latest utterance, previous accepted facts, current named step, and supplied candidate spans. Example questions: “Is the speaker replacing the phone they are using now?”; “Is the speaker asking about a possible different phone?”; “Does this report the result of check X?”; Choice of stated stage with a companion question checking whether any stage is stated. No question asks “what should we do next?”

Proposed starting Noul bands: `>0.7` yes, `<0.3` no, otherwise unresolved; these follow the skill's starting guidance, are **not calibrated for this task**, and cannot establish exact facts without confirmation. If replacement and hypothetical both score yes, ask clarification. No/error/uncertain branches are explicit; API timeout is not a negative semantic answer. Store actual model/version, question version and minimized request for consented synthetic evaluation. Do not assert exact probabilities in behavioral tests.

## 8. Data access, freshness and privacy

**Available now:** public source pages and synthetic cases authored from documented distinctions. **Unavailable now:** a real setup, reliable exporter schema, native app permissions and evidence of physical recovery.

Public sources: official manufacturer instructions first, controller instructions for the actual platform second, community reports as labeled hypotheses only. The source's scope wins over retrieval score. Conflicting instructions require narrower applicability or abstention. No arbitrary page text can expand tools, request secrets, or override policy. Restrict fetches to allowed public HTTPS hosts, validate redirects, and block loopback/private addresses and non-HTTP schemes.

Freshness policy, proposed: record every fetch/hash; revalidate operational source cards within **24 hours** before a live demo/session. Use curated snapshots offline only with captured date and explicit mode. Check known-issue status on each live use; if direct access fails, say unverified. Missing publication date remains unknown. A fresh crawl does not prove documentation matches installed firmware. HA's conflicting iOS minimum text is a reason to confirm the actual supported app/OS combination; proposed test targets Android 12+ with Google services and iOS 18+ are conservative scope choices, not vendor minimum claims.

### Import boundary, disabled in MVP

Candidate future paths: user-exported HA integration/device diagnostics; Thread Doctor JSON export; Thread Tools diagnostic reports. R01/R05/R06 establish features described by their publishers, **not** an implemented adapter or stable format. Start with one actual exporter/version after obtaining an authorized sample; for a never-paired accessory a device-level export may not exist. No copy-paste of full raw logs into chat.

1. File is selected locally. Limit to **1 MiB UTF-8 JSON**, maximum nesting **16**, maximum **100 node records**. Reject archives, executable content, remote URLs and unknown exporter/schema versions. These are proposed product limits.
2. Parse locally and **copy only allowed fields** into a new object: exporter/schema/capture time, nonunique model/firmware/protocol, explicit error enums, role/reachability and relevant diagnostic numbers with units. Omit all unknown keys. Do not rely on a blacklist or exporter redaction alone.
3. Drop Thread operational datasets/TLV blobs, master/network/PSKc keys, Wi-Fi passwords/SSIDs, setup QR/manual codes, pairing payloads, credentials/tokens, serials, device/home/account names, addresses, geolocation, MAC/IP/eUI/PAN and persistent fabric/node IDs. Create session-local pseudonyms for relationships; discard the original mapping. Do not hash secrets or stable identifiers into a transferable identifier.
4. Prefer local deterministic evaluation of diagnostics. External semantic models receive only minimal derived enums/booleans and needed nonunique identity/version fields. No raw strings/free-form log fields, opaque blobs or full topology leave the device. Unsupported fields mean unavailable evidence, never a model guess.
5. Show the exact proposed outgoing sanitized object and its recipients before opt-in. Decline leaves manual triage available. No external request occurs before preview/consent and adapter tests. Test unknown fields and secrets nested inside arrays.

Voice audio necessarily reaches Vapi and its chosen providers before backend text redaction. The design cannot guarantee that an accidentally spoken secret never reaches speech recognition. Therefore collect identifiers through constrained text fields, ask users not to read setup codes/passwords, offer mute/text, and keep imports out of the audio path. Any transcript that appears to contain a secret is quarantined from Exa/Jev/further application logs; the UI explains provider retention limits and a deletion path. Do not market end-to-end local processing or absolute voice secret prevention.

Default application case retention: memory only, **30-minute idle expiry**, explicit reset/delete, no raw audio recording by the app, no persistent raw transcript, and no server import upload endpoint. Export is user-initiated, local download. Verify provider recording/transcript/analysis settings before any real use; disable optional recording/storage/training where the actual plans support it, document remaining operational retention, and restrict public demos to synthetic/nonprivate speech until this is checked. Anonymous technical traces use IDs, versions and timing only; no full household transcript. No account setup is authorized now.

## 9. Support packet example: useful and inspectable

> **EXAMPLE CASE — synthetic household; not a recovered real device**
>
> Goal: add one new Matter-over-Thread accessory to Home Assistant.
> Identity: Eve Energy US/Canada, product 10EBU4151, model 20EBU4101; firmware unknown.
> Current phone: Android tablet, user-confirmed in example; OS/app build not yet supplied.
> Reported topology: HA Thread network and ZBT-2; no measured network data.
> Failure: user reports connectivity-check error; exact error text requested.
> Attempts: power checked (reported OK); credential sync reported attempted/failed; pairing retry not performed.
> Superseded context: initial iPhone report corrected; iPhone-specific instructions withheld.
> Hypothesis: phone prerequisites/credential availability may be relevant; not a diagnosed cause.
> Next action: supply OS/app/services status and sync outcome/error before another guided retry; consult the applicable official Thread guide [R02].
> Outcome: unresolved. No network access, no physical recovery verification, no reset recommended.

The packet should allow a person to resume without recounting the whole conversation. It never says “network healthy” from missing diagnostics or reports a proposed step as completed.

## 10. Meaningful verification and product validation

Every result below is a future acceptance criterion. None passed in this planning session.

| Test class | Required observable result |
|---|---|
| Genuine partial execution | Authorized live capture contains actual Vapi user partial events and a documentation dispatch timestamp before final speech. A replay proves engine behavior only, not provider delivery. |
| Acceptance-time stale race | Delayed iPhone lookup/judgment returns after Android correction; dependent output rejected; independent accessory evidence retained. |
| Pre-response race | Correct after acceptance but before output; old step never emitted. Correct between response chunks; remaining units stop and retraction is issued. |
| Identifier ambiguity | “Eve plug,” “ZBT two,” a malformed SKU, or reused model number cannot silently establish product/protocol/firmware. Exact typed confirmation or unknown outcome. |
| Repeated/contradictory corrections | iPhone → Android → iPhone, typed-vs-voice conflict, negation, hypothetical and changed mind all preserve ordered history and keep stale tasks ineligible. |
| Platform-specific instruction | Eligible Android branch uses its reviewed path; iPhone path never leaks after correction. Unknown app/OS/services triggers the relevant question. |
| Attempts | “Already tried,” “it failed,” “I haven't done that” and a correction to an outcome retain history and avoid fictitious completion/repeated failed advice. |
| Unsupported/version gaps | Unknown firmware permits only independent checks; explicit incompatible protocol/hub yields unsupported. No invented update/reset path. |
| API/source failure | Exa 401/429/timeout, Jev unavailable/malformed response, source 404/sign-in or conflicting docs cause truthful fallback, not cached certainty. |
| Session/reset isolation | Two sessions, old epoch callbacks, duplicate events, reconnect and process restart cannot cross-contaminate cases. Lost continuity asks for re-entry. |
| Import safety, only if enabled | Unknown schema rejected, allowlist strips nested secrets/IDs, outgoing payload preview matches bytes, cancel makes no request, stale captures labeled. |
| Real task or honest unresolved | Later hardware test records actual versions, starting failure, steps and controller/physical outcome; otherwise classify user report or unresolved with missing evidence. |

Proposed formative study after approval: five people who have attempted smart-home setup, using one documented task each; compare counterbalanced guided workflow with the relevant official guide, recording task outcome, repeated steps, unsupported claims and ability to continue from the packet. This is a learning sample, not a statistical superiority benchmark. No recruitment/contact is authorized now. Keep latency traces (partial received, dispatch, result, correction, response) but publish no latency or field-success claim before collecting actual measurements.

## 11. Go/no-go gates and practical timing

| Gate | Evidence required | If absent |
|---|---|---|
| **G0: approach/design approval** | User selects slice and approves this design (possibly revised) | Planning only; no scaffolding/accounts/dependencies/calls |
| **G1: truthful evidence mode** | Available hardware/export inventory and source applicability recorded | Use synthetic case with persistent label; no recovery claim |
| **G2: useful task** | One check has exact preconditions, source, expected observation and a packet an engineer can use | Reduce to readiness slice or stop; a narrated FAQ is insufficient |
| **G3: voice/event contract** | Real partial delivery, authenticated session binding, controlled response and interruption verified in first integration probe | Text/replay demo; remove live partial/correction guarantees |
| **G4: privacy/access** | Provider settings/terms and sanitized input boundaries verified | Synthetic/nonprivate data only; imports remain disabled |
| **G5: diagnostic path** | Authorized sample and exporter/version/schema, local sanitizer, permission model tested | No import feature; do not invent topology |
| **G6: product differentiation** | Users finish a meaningful next step or hand off without re-explaining, beyond what the guide/Thread Doctor already supplies | Reconsider workflow/audience before extending catalog |

Main risks: absent hardware; misleading synthetic success; unavailable native data; closed platform limits; generic-wrapper experience; inaccurate identifier recognition; overbroad source applicability; event noise/Wi-Fi restrictions; too much sponsor integration; and unreliable voice-session binding. None is solved by a larger prompt.

**90-minute event slice, only after authorization and eligibility verification:** 0–10 choose one existing/curated case and confirm accounts/network; 10–25 voice binding/partial/response probe; 25–45 state, current-step card and attempt record; 45–60 one correction race and curated source rule; 60–70 unresolved packet and reset; 70–80 minimum meaningful tests; 80–90 rehearse and choose live vs replay labels. Lightning talks reduce effective time. If starting from this empty directory with no accounts, a text/replay proof plus packet is the credible default, not all integrations.

Do not claim a native importer, cross-platform recovery coverage, arbitrary-model retrieval, real hardware fix, field validation or six-sponsor live integration can credibly be delivered in that window. Curated/rehearsed prework may be used only if actual event rules permit it. No submission is authorized here.

**Follow-on estimate, author proposal:** 3–5 focused engineering days for the narrow integration and robust state/response tests after access works; another 1–2 days for rehearsed hardware validation if hardware is available; a separately scoped export adapter/study afterward. These are planning allowances, not measured delivery commitments. Detailed dependency-ordered tasks are conditional in the plan.

## 12. Remaining decisions and approval

User decisions: select A/B/C (A recommended); approve HA-first commissioning boundary and fixture-only initial demonstration; approve or revise this design before any implementation. A real-device recovery promise is conditional on later inventory and physical evidence, not a decision that public documentation can satisfy.

Builder discretion after approval: compatible pinned package versions, precise visual styling, host/tunnel choice within privacy/SSE needs, minor file regrouping, and scheduling refinements demonstrated by tests. Do not change evidence labels, supported scope, response ownership or secret-handling boundaries as routine implementation choices.

The using-superpowers/brainstorming design gate remains in force: design approval is not inferred from liking the product direction. The accompanying implementation plan is a requested **conditional draft**, not a finalized plan based on an approved design. Review findings and any consequential changes will be recorded here before execution is considered.
