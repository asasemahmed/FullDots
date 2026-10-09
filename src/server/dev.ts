// Set the mode before loading modules that read NODE_ENV during initialization.
process.env.NODE_ENV = 'development';
await import('./index.js');
export {};
