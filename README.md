# Notatnik Trenera – strona ucznia

Strona, którą uczeń otwiera z linku od trenera (WhatsApp / SMS), bez instalowania aplikacji:
najbliższe zajęcia, plan, saldo i odwołanie zajęć w limicie godzin ustawionym przez trenera.

- W tym repozytorium jest **tylko kod strony** — żadnych danych uczniów.
- Dane przychodzą z Supabase po osobistym tokenie z linku (`#t=…`). Token jest po „#”, więc nie trafia do logów hostingu.
- Klucz w `index.html` to publiczny klucz `anon`; dostęp pilnują funkcje w bazie (`link_overview`, `link_cancel`, `link_undo`).
- Źródło: `web/uczen/index.html` w repozytorium aplikacji. Zmieniaj tam i kopiuj tutaj.

Hosting: GitHub Pages z gałęzi `main` (katalog główny).
