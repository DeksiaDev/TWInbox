# TW Inbox

Internal Deksia tool for managing Teamwork notifications, tasks, and team bandwidth.

## Setup

1. Clone the repo
2. `npm install`
3. Copy `.env.example` to `.env` and fill in values
4. `npm start`
5. App runs at `http://localhost:3847`

## Features

- **Inbox** — unread Teamwork notifications with @mention filtering, reply-in-place, snooze, dismiss
- **Today / My Week** — task counts by day, overdue tracking, inline task completion
- **Admin Panel** — team member management, bandwidth view across the team, bug reports
- **Themes** — per-user appearance preferences (Slate, Warm, Forest, Midnight, Mono)
- **Auth** — email/password via Supabase with password reset

## Stack

- Node.js + Express
- Supabase (auth + Postgres + Vault for API key encryption)
- Vanilla JS frontend
- Teamwork API v3 + v1
