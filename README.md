
## Setup

Install dependencies and prepare the build directory:

```sh
yarn
```

To watch files for changes, and launch a dev server:

```sh
yarn watch
```

## If you are developing posenet locally, and want to test the changes in the demos

Install dependencies:
```sh
yarn
```

Start the dev demo server:
```sh
yarn watch
```

Install yalc:
```sh
npm i -g yalc
```

Publish posenet locally:
```sh
yalc push
```

Link the local posenet to the demos:
```sh
yalc link \@tensorflow-models/posenet
```

