# Contributing

Thanks for wanting to make Freeloomz better. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

[Open an issue](https://github.com/chchchadzilla/Freeloomz/issues/new/choose) and say what you did, what you expected and what happened instead. Your operating system and how you installed Freeloomz matter a lot, so please include them.

## Changing the code

Freeloomz is plain JavaScript with no build step, so getting started is quick. You need [Node.js](https://nodejs.org) 22 or newer.

```bash
git clone https://github.com/chchchadzilla/Freeloomz.git
cd Freeloomz
npm install
npm start
```

Before opening a pull request:

```bash
npm run typecheck
npm test
npm run test:e2e
```

The end-to-end tests launch the real app and make real recordings; on Linux they start their own virtual display. The README explains how the app is put together and what each test covers.

A few things that keep the project pleasant to work on:

- Keep changes focused: one fix or feature per pull request.
- If you change how something looks, run `npm run screenshots` and `npm run icons` so the README stays true.
- New behaviour deserves a test. Bug fixes deserve one that fails without the fix.

## Ideas

The [roadmap](README.md#roadmap) lists what is planned. If you want to take one on, open an issue first so we can agree on the shape of it.
