import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  
  const productId = formData.get("productId");
  const file = formData.get("file");
  const filename = formData.get("filename") || file.name;
  const mimeType = file.type || "image/jpeg";

  if (!productId || !file) {
    return Response.json({ error: "Missing productId or file" }, { status: 400 });
  }

  try {
    // 1. Create Staged Upload
    const stagedUploadsResponse = await admin.graphql(
      `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          input: [
            {
              resource: "IMAGE",
              filename,
              mimeType,
              httpMethod: "POST",
            },
          ],
        },
      }
    );

    const stagedUploadsJson = await stagedUploadsResponse.json();
    const target = stagedUploadsJson.data?.stagedUploadsCreate?.stagedTargets?.[0];
    const userErrors = stagedUploadsJson.data?.stagedUploadsCreate?.userErrors;

    if (userErrors && userErrors.length > 0) {
      return Response.json({ error: "Error creating staged upload", details: userErrors }, { status: 400 });
    }

    if (!target) {
      return Response.json({ error: "Failed to get staged upload target" }, { status: 500 });
    }

    // 2. Upload File to Staged Target
    const uploadFormData = new FormData();
    target.parameters.forEach((param) => {
      uploadFormData.append(param.name, param.value);
    });
    uploadFormData.append("file", file);

    const uploadResponse = await fetch(target.url, {
      method: "POST",
      body: uploadFormData,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      return Response.json({ error: "Failed to upload to staged target", details: errorText }, { status: 500 });
    }

    // 3. Attach Media to Product
    const attachMediaResponse = await admin.graphql(
      `#graphql
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media {
            id
            mediaContentType
            status
          }
          mediaUserErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          productId,
          media: [
            {
              originalSource: target.resourceUrl,
              mediaContentType: "IMAGE",
            },
          ],
        },
      }
    );

    const attachMediaJson = await attachMediaResponse.json();
    const mediaErrors = attachMediaJson.data?.productCreateMedia?.mediaUserErrors;

    if (mediaErrors && mediaErrors.length > 0) {
      return Response.json({ error: "Error attaching media to product", details: mediaErrors }, { status: 400 });
    }

    return Response.json({ success: true, media: attachMediaJson.data.productCreateMedia.media[0] });

  } catch (error) {
    console.error("Upload error:", error);
    return Response.json({ error: "Internal server error", details: error.message }, { status: 500 });
  }
};
