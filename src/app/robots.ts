import {readActiveSite} from '@/lib/site-request';
import {discoveryRobots} from '@/lib/discovery';
export const dynamic='force-dynamic';
export default async function robots(){return discoveryRobots(await readActiveSite());}
