// If this ever imports external code, this needs to be wrapped in a `declare global {}` block
// https://stackoverflow.com/questions/57040272/what-is-declare-global-in-typescript/57040462#57040462
declare namespace Express {
  // Extend the User interface with values from Passport
  interface User {
    id: number;
    username: string;
  }
}
