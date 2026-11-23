import { randomInt } from 'node:crypto';

// Short, unambiguous, inoffensive words: "quiet-amber-falcon". About 300,000 combinations.
const MOODS = ['quiet', 'brave', 'calm', 'eager', 'gentle', 'happy', 'jolly', 'kind', 'lively', 'merry', 'noble', 'proud', 'swift', 'witty', 'bold', 'bright',
  'clever', 'cosy', 'crisp', 'daring', 'fancy', 'fresh', 'glad', 'grand', 'humble', 'keen', 'lucky', 'mellow', 'neat', 'nimble', 'plucky', 'polite',
  'rapid', 'sunny', 'tidy', 'vivid', 'warm', 'wise', 'zesty', 'agile', 'breezy', 'cheery', 'dapper', 'early', 'fair', 'frosty', 'gleaming', 'hearty',
  'lofty', 'lunar', 'misty', 'modest', 'patient', 'quick', 'rustic', 'serene', 'silent', 'sleek', 'snowy', 'solar', 'steady', 'stellar', 'sturdy', 'tender'];
const COLORS = ['amber', 'azure', 'beige', 'bronze', 'cedar', 'cherry', 'cobalt', 'copper', 'coral', 'cream', 'crimson', 'denim', 'ebony', 'emerald', 'garnet', 'ginger',
  'golden', 'granite', 'hazel', 'honey', 'indigo', 'ivory', 'jade', 'lemon', 'lilac', 'lime', 'maple', 'marble', 'mint', 'mocha', 'navy', 'ochre',
  'olive', 'onyx', 'opal', 'orchid', 'pearl', 'plum', 'ruby', 'rust', 'saffron', 'sage', 'sand', 'scarlet', 'silver', 'slate', 'teal', 'violet'];
const NOUNS = ['falcon', 'otter', 'badger', 'beaver', 'bison', 'crane', 'dolphin', 'eagle', 'ferret', 'finch', 'fox', 'gecko', 'heron', 'ibis', 'jaguar', 'koala',
  'lark', 'lemur', 'lynx', 'marten', 'moose', 'newt', 'ocelot', 'osprey', 'owl', 'panda', 'parrot', 'pelican', 'puffin', 'quail', 'rabbit', 'raven',
  'robin', 'salmon', 'seal', 'sparrow', 'stork', 'swan', 'tiger', 'toucan', 'turtle', 'walrus', 'whale', 'wolf', 'wren', 'yak', 'zebra', 'alpaca',
  'acorn', 'aspen', 'birch', 'brook', 'canyon', 'cliff', 'clover', 'comet', 'cove', 'delta', 'dune', 'ember', 'fern', 'fjord', 'glade', 'grove',
  'harbor', 'island', 'lagoon', 'lantern', 'meadow', 'mesa', 'nebula', 'oak', 'orbit', 'pebble', 'pine', 'prairie', 'quartz', 'reef', 'ridge', 'river',
  'sierra', 'spruce', 'summit', 'thicket', 'tundra', 'valley', 'willow', 'atlas', 'beacon', 'compass', 'harp', 'kite', 'meteor', 'prism', 'sail', 'voyage'];

const pick = (words: readonly string[]) => words[randomInt(words.length)]!;

/** Three random words, such as `quiet-amber-falcon`. */
export function tunnelName(): string {
  return `${pick(MOODS)}-${pick(COLORS)}-${pick(NOUNS)}`;
}
