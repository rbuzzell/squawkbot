import * as C from 'commander';

import * as squawk from './index';

const program = new C.Command();

program
  .name('squawkbot')
  .description('Discord counting bot')
  .version('0.6.9')
  .option('--evaluator <url>', 'eval endpoint', 'https://counter.robgssp.com')
  .option('--allow-repeats', 'allow multiple guesses in a row')
  .option('--register-commands', 'register bot commands')
  .option('--test', 'test mode')
  .parse();

squawk.main(program.opts());
