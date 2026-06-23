import {
  Group,
  Box,
  Button,
  TextInput,
  Stack,
  Textarea,
  Divider,
  Switch,
} from "@mantine/core";
import React, { useState } from "react";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { z } from "zod/v4";
import { useUpdateSpaceMutation } from "@/features/space/queries/space-query.ts";
import { ISpace } from "@/features/space/types/space.types.ts";
import { useTranslation } from "react-i18next";

const formSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500),
  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(
      /^[a-zA-Z0-9]+$/,
      "Space slug must be alphanumeric. No special characters",
    ),
});

type FormValues = z.infer<typeof formSchema>;
interface EditSpaceFormProps {
  space: ISpace;
  readOnly?: boolean;
}
export function EditSpaceForm({ space, readOnly }: EditSpaceFormProps) {
  const { t } = useTranslation();
  const updateSpaceMutation = useUpdateSpaceMutation();

  const [gitSyncEnabled, setGitSyncEnabled] = useState<boolean>(
    space?.settings?.gitSync?.enabled ?? false,
  );

  const handleGitSyncToggle = async (value: boolean) => {
    const previous = gitSyncEnabled;
    setGitSyncEnabled(value); // optimistic update
    try {
      await updateSpaceMutation.mutateAsync({
        spaceId: space.id,
        gitSyncEnabled: value,
      });
    } catch (err) {
      setGitSyncEnabled(previous); // revert on failure
      // The mutation surfaces a toast via onError; still log the raw error so it
      // is not silently swallowed (AGENTS.md).
      console.error("Failed to toggle git-sync for space", err);
    }
  };

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: {
      name: space?.name,
      description: space?.description || "",
      slug: space.slug,
    },
  });

  const handleSubmit = async (values: {
    name?: string;
    description?: string;
    slug?: string;
  }) => {
    const spaceData: Partial<ISpace> = {
      spaceId: space.id,
    };
    if (form.isDirty("name")) {
      spaceData.name = values.name;
    }
    if (form.isDirty("description")) {
      spaceData.description = values.description;
    }

    if (form.isDirty("slug")) {
      spaceData.slug = values.slug;
    }

    await updateSpaceMutation.mutateAsync(spaceData);
    form.resetDirty();
  };

  return (
    <>
      <Box>
        <form onSubmit={form.onSubmit((values) => handleSubmit(values))}>
          <Stack>
            <TextInput
              id="name"
              label={t("Name")}
              placeholder={t("e.g Sales")}
              variant="filled"
              readOnly={readOnly}
              {...form.getInputProps("name")}
            />

            <TextInput
              id="slug"
              label={t("Slug")}
              variant="filled"
              readOnly={readOnly}
              {...form.getInputProps("slug")}
            />

            <Textarea
              id="description"
              label={t("Description")}
              placeholder={t("e.g Space for sales team to collaborate")}
              variant="filled"
              readOnly={readOnly}
              autosize
              minRows={1}
              maxRows={3}
              {...form.getInputProps("description")}
            />
          </Stack>

          {!readOnly && (
            <Group justify="flex-end" mt="md">
              <Button type="submit" disabled={!form.isDirty()}>
                {t("Save")}
              </Button>
            </Group>
          )}
        </form>

        <Divider my="lg" />

        <Switch
          label={t("Enable Git sync")}
          description={t("Sync this space's pages to a Git repository.")}
          checked={gitSyncEnabled}
          disabled={readOnly || updateSpaceMutation.isPending}
          onChange={(event) =>
            handleGitSyncToggle(event.currentTarget.checked)
          }
        />
      </Box>
    </>
  );
}
