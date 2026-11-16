# 02 — BLAZE 2026 requirements checklist

Status: researched 2026-11-16. Deadline: **Sun 22 Nov 2026, 14:00 UTC.**

## How reliable this is

The official rules are on the DoraHacks page (<https://dorahacks.io/hackathon/bchblaze2026/detail>), but our fetch
tool could not load it (HTTP 405, the page needs JavaScript). The rules below come from:

- **[O] official, read directly:** [bchblaze.cash](https://bchblaze.cash/),
  [/schedule/](https://bchblaze.cash/schedule/), [/live/](https://bchblaze.cash/live/),
  [/bounties/](https://bchblaze.cash/bounties/), [/tokenhunt/](https://bchblaze.cash/tokenhunt/), and the Widget
  Factory template deck.
- **[D] DoraHacks text, seen in search-engine snippets** of the DoraHacks detail and tracks pages
  (<https://dorahacks.io/hackathon/bchblaze2026/>, <https://dorahacks.io/hackathon/bchblaze2026/tracks>).
- **[T] third-party summaries** of the DoraHacks page by other entrants:
  [chaitip RESEARCH.md](https://github.com/MSAbhishek22/chaitip/blob/main/RESEARCH.md),
  [Ajochain README](https://github.com/Afar88/Ajochain),
  [bch-pay-links README](https://github.com/Samurc97/bch-pay-links), and
  [The BCH Bullet, 18 Oct 2026](https://thebchbullet.substack.com/p/the-bch-bullet-sunday-18th-october).

> **Action for a human (5 minutes):** open the DoraHacks detail page in a browser, compare it with this file, and fix
> anything that differs. The roll-call rule (item A2) matters most.

## A. Eligibility and admin

- [ ] **A1. Registered on DoraHacks before registration closed (Fri 13 Nov).** [O] schedule. One entrant wrote
  "hacking Nov 14–22 is pre-registered teams only" ([T] [gist](https://gist.github.com/adophilus/6316b5add284c570175e869834fe594d)).
  IMPLEMENTATION.md §0 still lists "Register the project on DoraHacks" as unchecked. **Confirm the hacker registration
  happened**; the BUIDL submission is a separate step done later.
- [ ] **A2. Roll call: at least one team member attended one BLAZE stream and joined its roll call.** [D] "One team
  member must be present for at least one stream"; roll call details are posted live on DoraHacks and Telegram while it
  is open, and at <https://bchblaze.cash/live/> (form: connect a wallet, DoraHacks username, optional 200-character
  project summary) [O]. **Which streams count is unclear:** one version of the DoraHacks eligibility text lists the
  Kick-off Stream on 14 Nov as a qualifying stream, another version omits it [D], and one summary lists only the
  information session and workshops 1–3 [T chaitip]. The organisers can waive roll call and the Telegram check-in for
  "known reputable builders" [D].
  - Streams: Info session Sat 17 Oct · Workshop 1 Sat 24 Oct · Workshop 2 Sat 31 Oct · Workshop 3 Sat 7 Nov ·
    **Kick-off Sat 14 Nov** · **Final Check-In Sat 21 Nov** · Showcase Sat 28 Nov (all 14:00 UTC) [O].
- [ ] **A3. Telegram check-in:** confirm in the BCH BLAZE Telegram (<https://t.me/bchblaze>) that the project is real
  [T BCH Bullet, chaitip, Ajochain, bch-pay-links].
- [ ] **A4. Team:** solo or up to four members [O].
- [ ] **A5. Originality:** original work, or work "significantly improved during the hackathon"; small tweaks do not
  count. Pre-existing work is allowed if the banner clearly discloses it, and then the banner must also link the old
  and new repos and show a demo of the project as it was before the hackathon [T chaitip; the D snippets agree
  that the banner carries the disclosure].

## B. Mainnet track rules

- [ ] **B1. At least one feature sends BCH mainnet transactions** [D].
- [ ] **B2. Anyone can make that transaction in the app without special setup** [D]. A judge with an ordinary wallet
  must be able to do it.
- [ ] **B3. A live, usable demo that judges open with one website link** [D].
- [ ] **B4. WizardConnect integration, or an XO Template integration, or both** [D]. [O bounties] marks WizardConnect
  as recommended on the BCH side. [D] notes this can be tested with WizardConnect on bchblaze.cash during the streams.
- [ ] **B5. A short presentation based on the "Widget Factory" template** [D tracks page]. See section D.
- [ ] **B6. The banner** (section C).
- [ ] **B7. Public source code** (GitHub or another forge), linked from the banner [T].

## C. The banner

The project needs a **banner at the top of the page**, or an easy-to-find description (for example a YouTube video
description) that holds the same items [D]. Items [T chaitip; the D snippet is cut off before the list]:

- [ ] **C1. Link to the short presentation** (Widget Factory template).
- [ ] **C2. Link to the source repo.**
- [ ] **C3. A CashTokens (token-aware, `bitcoincash:z…`) address that receives EMBER2026 tokens** for community-choice
  voting.
- [ ] **C4. If any work predates the hackathon: a disclosure, links to the old and new repos, and a demo of the
  pre-hackathon version.**
- Our addition (not a rule): the Cermin and Wysiwys credit. Keeping it in the banner also covers C4 if a judge asks
  whether the idea is original.

## D. The Widget Factory deck

- The template is a public Google Slides deck titled **"BLAZE 2026 Project Template"**:
  <https://docs.google.com/presentation/d/1Yfuk9CJkf4U9M_WukcELhumWgj3Ak6345Ewy8hSp-Hk/edit?usp=sharing>
  [T chaitip; deck read directly, O].
- It is a seven-slide sample pitch for a made-up project called "Widget Factory": 1 title (name, website, X and
  Telegram handles, team) · 2 one-line pitch + GitHub link · 3 the story · 4 benefits · 5 BCH usage · 6 vision ·
  7 thank you. It has no written instructions, no length limit and no rule about where the deck must live.
- [ ] **D1.** Make a copy (File → Make a copy), keep the seven-slide structure, and share it as "anyone with the link
  can view". Put the link in the banner and in the DoraHacks submission. Our outline:
  [03-deck-outline.md](03-deck-outline.md).

## E. Community choice (EMBER2026)

- [ ] **E1.** Community Choice: **$750 PUSD** to the project whose CashTokens address receives the most EMBER2026
  tokens. EMBER2026 is airdropped to holders of BLISS Belle NFTs [T chaitip].
- [ ] **E2.** Create the address in a wallet we control (token-aware `z…` form), test it with a small token transfer,
  and show it in the banner with copy and QR (DESIGN.md §3 already plans this).
- [ ] **E3.** Ask for votes in the BLAZE Telegram and on X once the demo is live (optional, but this prize is decided by
  votes).

## F. Judging (mainnet track)

- [D] lists at least **Innovation & creativity** ("Is it cool?") and **Business or investment potential** ("Will it
  make money?").
- [T chaitip] lists four categories, 10 points each per judge: innovation & creativity; design & usability; technical
  strength (use of BCH properties, bugs, scalability, security); business & investment potential. Judges: Elliot Price,
  Kallisti, Sayoshi Nakamario. Ties go to the judges' favourite (2 of 3). **Judges spend about a couple of minutes per
  project by default**, so a simple thing that works beats a complex, confusing one.
- Judging runs 23–27 Nov; results at the Showcase stream, Sat 28 Nov 14:00 UTC [O].

## G. Prizes (for context)

Total about $8,000, paid in ParyonUSD [O]. Mainnet 1st $3,500 PUSD + BLISS 2027 tickets for the team; 2nd $1,500 PUSD
+ one ticket; 3rd $750 PUSD + one ticket; Media track $1,000 PUSD; Community Choice $750 PUSD; TokenHunt pool $250 PUSD
[T chaitip; the 1st-place figure is confirmed by the BCH Bullet]. Bounties are extra, and a project may enter several
[O bounties].

Bounties that touch our project [O]:
- **Build with XO** (0.3 BCH each, up to 10 winners): needs a novel XO template, a Chipnet or mainnet tx through an
  inspectable invitation, the template and reproduction steps, and about 500 words of feedback **written personally;
  AI-written feedback is rejected**. Only if we have time after the main build.
- Stablecoin Bridge, Identity, SolidCash, FoldingCash: not a fit.

## H. DoraHacks submission (BUIDL) fields

We could not see the form. DoraHacks BUIDL submissions usually ask for: name, logo, one-line pitch, description,
GitHub link, demo or website link, video link, the hackathon track (Mainnet), bounties, and team members. Have these
ready:

- [ ] Name: sigsig · one-liner · description (from README)
- [ ] Logo (square) and a banner image (`shoot.mjs` share tile, DESIGN.md §9)
- [ ] Repo URL (public)
- [ ] Live demo URL (mainnet)
- [ ] Deck URL (Widget Factory copy)
- [ ] Video URL (2–3 min; not listed as required, but it helps judges with limited time)
- [ ] EMBER2026 address
- [ ] Track: Mainnet; bounties: none unless we do XO
- [ ] Mainnet tx IDs the judges can check (vault setup, one defend or skim, one pay)
- [ ] Credits: Cermin, Wysiwys, ParyonUSD

## I. What IMPLEMENTATION.md misses or gets wrong

| # | Gap | Risk | Fix |
|---|---|---|---|
| 1 | **Roll call.** The plan put it at the 14 Nov kick-off stream, and that box is still unchecked. If we missed it, or if the kick-off does not count (A2), the only stream left before the deadline is the **Final Check-In, Sat 21 Nov 14:00 UTC**. | **High: eligibility** | Confirm who attended on 14 Nov and whether their DoraHacks username showed up in the roll call. Whatever the answer, put one person on the 21 Nov stream with a wallet connected on bchblaze.cash/live, and ask in Telegram now whether that stream counts or whether a waiver is possible. |
| 2 | **DoraHacks registration** is still unchecked in §0, and registration closed 13 Nov. | **High: eligibility** | Confirm the hacker registration exists. If not, message the organisers on Telegram today. |
| 3 | **Telegram check-in** is not done. | Medium: eligibility | Post a short "sigsig is real" message with the repo link in t.me/bchblaze today. |
| 4 | **A judge must always be able to send a mainnet transaction** (B2). Defend and skim are refused while CR sits inside the band, and the "tip vault" design is still open (§2.7, "decide on day 6"). | **High: the core track rule** | Ship one action that always works for any connected wallet, for example the 1 000-sat allowlisted demo payment, and keep "Run keeper" as a bonus. The landing page should lead straight to it. |
| 5 | The plan says "WizardConnect **+ XO wallet**". The rule is WizardConnect **or an XO Template**, and XO is a template system (an XO-bounty item), not just a wallet. | Medium: time | WizardConnect alone meets B4. Drop the XO-wallet work unless we go after the XO bounty. |
| 6 | **Disclosure of earlier work** (A5, C4). Our design docs date from 13 Nov, one day before hacking started, and the idea comes from Cermin. | Medium | Keep the Cermin/Wysiwys credit in the banner. State in the README and the submission that no code was copied and that the design notes are dated 13 Nov. |
| 7 | The deck plan (§2.8) uses its own sections. The template has seven fixed slides (D). | Low | Follow [03-deck-outline.md](03-deck-outline.md), which maps our content onto the seven slides. |
| 8 | Judges spend about 2 minutes per project (F). | Medium: score | The first screen must show the live vault and one button to do the mainnet tx. Keep the video at 2–3 minutes. |
| 9 | "Design & usability" is a scored category (F, T). | Low | Already covered by the taste-skill gate (day 7). |
| 10 | Submission time: the plan aims for 12:00 UTC on 22 Nov, two hours early. | OK | Keep it. Also fill the DoraHacks BUIDL draft by 21 Nov. |
| 11 | EMBER2026 address: planned for the banner, but no step creates or tests it. | Low | Make and test it on day 8 (E2). |

## Sources

- BLAZE site: <https://bchblaze.cash/>, <https://bchblaze.cash/schedule/>, <https://bchblaze.cash/live/>,
  <https://bchblaze.cash/forge/>, <https://bchblaze.cash/bounties/>, <https://bchblaze.cash/tokenhunt/>
- DoraHacks: <https://dorahacks.io/hackathon/bchblaze2026/detail>, <https://dorahacks.io/hackathon/bchblaze2026/tracks>,
  <https://dorahacks.io/hackathon/bchblaze2026/resources>
- Template deck: <https://docs.google.com/presentation/d/1Yfuk9CJkf4U9M_WukcELhumWgj3Ak6345Ewy8hSp-Hk/edit?usp=sharing>
- Telegram: <https://t.me/bchblaze> · X: <https://x.com/bchblaze>
- The BCH Bullet: <https://thebchbullet.substack.com/p/the-bch-bullet-sunday-18th-october>,
  <https://thebchbullet.substack.com/p/the-bch-bullet-sunday-8th-november>
- Entrants' summaries: <https://github.com/MSAbhishek22/chaitip>, <https://github.com/Afar88/Ajochain>,
  <https://github.com/Samurc97/bch-pay-links>
