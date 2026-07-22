# Press Shop Planner

A production planning application built with Next.js and Firebase Studio, designed for shop floor planners and operations teams to manage scheduling, machine utilization, and downtime planning.

## Overview

Press Shop Planner delivers an intuitive planning experience with configurable machines, parts, production plans, downtime tracking, and discrepancy reporting.

Key capabilities:
- Machine and part configuration management
- Production plan generation and review
- Downtime planning dashboard
- Discrepancy reporting for unplanned events
- Responsive UI with dark/light theme support

## Technology stack

- Next.js 15
- React 18
- TypeScript
- Tailwind CSS
- Firebase
- GenKit AI integration
- Recharts for charts
- Zod for runtime validation
- react-hook-form for form handling

## Getting started

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Open `http://localhost:9002` in your browser to view the app.

## Deployment

- Production: `https://press-shop-planner.vercel.app/`

> Replace these links with your actual deployment URLs once the app is published.

## Scripts

- `npm run dev` — start the Next.js development server
- `npm run build` — build the production application
- `npm run start` — run the production server after build
- `npm run lint` — run Next.js linting
- `npm run typecheck` — run TypeScript type checking
- `npm run genkit:dev` — start GenKit AI development mode
- `npm run genkit:watch` — start GenKit AI with watch mode

## Project structure

- `src/app` — application routes and pages
- `src/components` — shared UI and application components
- `src/hooks` — custom React hooks
- `src/lib` — shared utilities, types, and initial data
- `src/ai` — AI integration and prompt flows

## Notes

This repository is configured for professional development and supports future extension for production planning workflows, analytics, and integrations.

## Contact

For questions or contributions, review the code in `src/` and submit issues or pull requests.
