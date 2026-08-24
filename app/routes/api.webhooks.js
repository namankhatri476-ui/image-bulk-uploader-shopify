import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    const { shop, topic } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return new Response("Webhook Error", { status: 400 });
  }
};

export const loader = async () => {
  return new Response("Webhook Endpoint Active", { status: 200 });
};
