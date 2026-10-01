# Mail an den Verein — Vorstellung der Handball-Seite

Entwurf zum Anpassen. Platzhalter in `[eckigen Klammern]` vor dem Versand ersetzen.

---

**An:** [Vorstand / Pressewart / Jugendleitung der HSG Wölfe Voreifel]
**Betreff:** Kleines Geschenk für die Wölfe: Spielplan, Tabelle und Ergebnisse aller Teams auf einer Seite

Hallo [Name],

mein Name ist Niklas Fauteck, ich bin [Spielervater / Mitglied / Fan] der HSG Wölfe
Voreifel und verfolge [unsere Mannschaft / die Spiele meines Sohnes / meiner Tochter]
schon eine ganze Weile. Beruflich und privat beschäftige ich mich gern mit
Digitalisierung — und in letzter Zeit vor allem mit „Vibecoding“, also dem
Programmieren zusammen mit einer KI.

Aus reinem Spaß daran ist dabei eine kleine Seite für unsere Mannschaften
entstanden, die ich euch gern zeigen möchte:

👉 **[Link zur Seite, z. B. https://woelfe.example.de/]**

**Was die Seite kann**

- **Alle Teams auf einen Blick:** Über ein Auswahlmenü oben wechselt man zwischen
  allen Mannschaften des Vereins — von den Herren bis zur Jugend.
- **Nächstes Spiel und letztes Ergebnis** mit einem kurzen Profil des Gegners.
- **Tabelle** mit Trendpfeilen, **Spielplan** mit Spielverläufen und eine
  **Saisonkurve**.
- **Immer aktuell:** Die Daten kommen automatisch von handball.net; am Spieltag wird
  bis zum Endstand nachgeschaut.
- **Spieltermine im eigenen Kalender:** Ein Klick abonniert den Spielplan im Handy-
  oder Outlook-Kalender, Verlegungen kommen automatisch mit.
- **Benachrichtigungen:** Wer möchte, bekommt Ankündigung, Halbzeit- und Endstand als
  Push-Nachricht im Browser oder über einen Telegram-Bot.
- **Zum Teilen gemacht:** Teilen-Knopf und schöne Vorschaubilder für WhatsApp & Co. —
  in unseren Vereinsfarben.

**Was die Seite nicht tut**

- Keine Werbung, keine Anmeldung, keine Cookies, kein Tracking.
- **Keine Spielernamen** — gerade bei den Jugendteams sind die standardmäßig
  ausgeblendet und erscheinen nur, wenn ihr das ausdrücklich wollt.
- Die Seite wird nicht von Suchmaschinen gefunden; sie ist zum Teilen gedacht, nicht
  zum Suchen.
- Es entstehen dem Verein keine Kosten. Ich betreibe die Seite auf meinem eigenen
  Server.

**Offen und nachvollziehbar**

Der komplette Quellcode liegt frei einsehbar auf GitHub (MIT-Lizenz):
**[https://github.com/Fauteck/handballteck]**
Wer im Verein technisch interessiert ist, kann also jederzeit reinschauen — oder die
Seite später auch selbst betreiben.

**Meine Frage an euch**

Hättet ihr Lust, die Seite für den Verein zu nutzen? Zum Beispiel:

1. als Link auf der Vereinshomepage oder in den Social-Media-Kanälen,
2. zum Weitergeben an Spieler, Eltern und Fans in den Mannschafts-Gruppen,
3. gern auch unter einer eigenen Adresse des Vereins (z. B. eine Subdomain eurer
   Homepage) — das lässt sich einfach einrichten.

Ich freue mich über ehrliche Rückmeldung — auch wenn ihr Wünsche habt, was fehlt, was
anders aussehen soll, oder wenn ihr lieber darauf verzichten möchtet. Gern zeige ich
euch die Seite auch kurz persönlich, z. B. am Rand eines Heimspiels.

Sportliche Grüße
Niklas Fauteck
[Telefon]
[E-Mail]

---

## Vor dem Versand prüfen

- [ ] Link zur Seite und zum Repo eingesetzt; Repo ist **öffentlich** (sonst Absatz
      „Offen und nachvollziehbar“ streichen).
- [ ] Eigene Rolle im Verein eingesetzt.
- [ ] `SITE_OPERATOR` und `SITE_FEEDBACK_MAIL` in der `.env` gesetzt, damit im Footer
      ein Ansprechpartner steht.
- [ ] `SITE_PLAYERS=false` gelassen, solange der Verein nicht zugestimmt hat.
- [ ] Optional: Telegram-Bot-Link ergänzen (`t.me/<bot>?start=<code>`), falls
      `TELEGRAM_INVITE_CODE` gesetzt ist.
